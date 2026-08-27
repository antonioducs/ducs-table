import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Panel, PanelGroup, PanelResizeHandle, type ImperativePanelHandle } from "react-resizable-panels";
import { Copy, DatabaseZap, FolderPlus, RefreshCw, Save, Trash2, WifiOff } from "lucide-react";
import { Toaster, toast } from "sonner";
import { bridge, getErrorMessage, normalizeSource } from "@/lib/bridge";
import { appErrorToastDescription, ImportFailureToastDeduper, presentAppError } from "@/lib/app-error";
import { flushAllProjectSessions, flushProjectSession, markProjectSessionSaved, scheduleProjectSessionSave } from "@/lib/project-session-sync";
import { quoteIdentifier } from "@/lib/utils";
import type {
  ConnectionInfo,
  DataRow,
  AppErrorInfo,
  ExternalRelationInfo,
  GridResourceRef,
  ImportOptions,
  ImportPathsResult,
  ImportStartResult,
  Job,
  Project,
  SavedQuery,
  SourceInfo,
  WorkbookSheets,
} from "@/types";
import { recentProjects } from "@/lib/projects";
import {
  selectActiveRelation,
  selectActiveSource,
  selectActiveTab,
  selectActiveWorkspace,
  preserveWorkspaceMutations,
  selectProjects,
  selectWorkspaceQueries,
  selectWorkspaceSources,
  useAppStore,
  type AppTab,
} from "@/stores/app-store";
import { focusedDocumentId, listGroupIds } from "@/lib/workbench";
import { isFileDrag } from "@/lib/file-drop";
import DataGrid, { type GridViewState } from "@/components/data-grid/DataGrid";
import SQLEditorTab from "@/components/sql-editor/SQLEditorTab";
import { TopBar } from "@/components/layout/TopBar";
import { Sidebar } from "@/components/layout/Sidebar";
import { SidebarToggle } from "@/components/layout/SidebarToggle";
import { SidebarRail } from "@/components/layout/SidebarRail";
import { StatusBar } from "@/components/layout/StatusBar";
import { WorkbenchLayout } from "@/components/workbench/WorkbenchLayout";
import { EditorGroup } from "@/components/workbench/EditorGroup";
import { EmptyState } from "@/components/import/EmptyState";
import { ImportStatusBanner } from "@/components/import/ImportStatusBanner";
import { RetryImportDialog, SheetPicker } from "@/components/import/ImportDialogs";
import { JobsPanel } from "@/components/jobs/JobsPanel";
import { ConfirmDialog, ExportDialog, NameDialog } from "@/components/layout/ActionDialogs";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/badge";
import { ConnectionDialog } from "@/components/connections/ConnectionDialog";
import { ConnectionAttachDialog } from "@/components/connections/ConnectionAttachDialog";
import { ConnectionManagerDialog } from "@/components/connections/ConnectionManagerDialog";
import { ProjectManagerDialog } from "@/components/projects/ProjectManagerDialog";
import { AIChatPanel } from "@/components/ai/AIChatPanel";
import { useAIStore } from "@/stores/ai-store";

type PendingDelete = { kind: "dataset" | "result" | "query"; projectId: string; id: string; name: string };
type PendingDetach = { projectId: string; connection: ConnectionInfo };

const emptyView: GridViewState = { sorts: [], filters: [], visibleColumns: [] };

function projectName(projectId: string): string {
  return useAppStore.getState().projects[projectId]?.name ?? "Unknown project";
}

function projectToast(projectId: string, message: string): string {
  return useAppStore.getState().activeProjectId === projectId ? message : `${projectName(projectId)} · ${message}`;
}

function missingExternalRelation(error: unknown): boolean {
  const message = getErrorMessage(error);
  return message.includes("[EXTERNAL_RELATION_NOT_FOUND]") || message.includes("[CONNECTION_NOT_FOUND]");
}

function flushStoredProjectSession(projectId: string): Promise<void> {
  return flushProjectSession(projectId, useAppStore.getState().projectWorkspaces[projectId]?.session);
}

async function validateExternalTabs(projectId: string, connection: ConnectionInfo): Promise<void> {
  const tabs = useAppStore.getState().projectWorkspaces[projectId]?.session.tabs.filter((tab) => tab.connectionId === connection.id && tab.relationId) ?? [];
  await Promise.all(tabs.map(async (tab) => {
    try {
      const relation = await bridge.GetExternalRelation({ projectId, id: tab.relationId! });
      useAppStore.getState().upsertExternalRelation(projectId, relation);
    } catch (error) {
      if (missingExternalRelation(error)) {
        useAppStore.getState().closeTab(projectId, tab.id);
        toast.warning(projectToast(projectId, `“${tab.title}” no longer exists and its tab was closed.`));
      } else {
        useAppStore.getState().markExternalPlaceholder(projectId, tab.relationId!, "disconnected");
        toast.warning(projectToast(projectId, `“${tab.title}” could not be validated yet and remains available.`));
      }
    }
  }));
}

export default function App() {
  const store = useAppStore();
  const workspace = selectActiveWorkspace(store);
  const projects = useMemo(() => store.projectIds.map((id) => store.projects[id]).filter(Boolean), [store.projectIds, store.projects]);
  const sources = useMemo(() => selectWorkspaceSources(workspace), [workspace]);
  const savedQueries = useMemo(() => selectWorkspaceQueries(workspace), [workspace]);
  const activeConnectionIds = workspace?.connectionIds;
  const connections = useMemo(() => activeConnectionIds ? activeConnectionIds.map((id) => store.connectionsById[id]).filter(Boolean) : [], [activeConnectionIds, store.connectionsById]);
  const globalConnections = useMemo(() => Object.values(store.connectionsById).sort((a, b) => a.name.localeCompare(b.name)), [store.connectionsById]);
  const jobs = useMemo(() => store.jobIds.map((id) => store.jobsById[id]).filter(Boolean), [store.jobIds, store.jobsById]);
  const activeSource = selectActiveSource(store);
  const activeRelation = selectActiveRelation(store);
  const activeProjectId = store.activeProjectId;
  const activeProject = activeProjectId ? store.projects[activeProjectId] : undefined;
  const activeTab = selectActiveTab(store);
  const activeConnectionId = activeRelation?.connectionId ?? activeTab?.connectionId;
  const activeConnection = activeConnectionId ? store.connectionsById[activeConnectionId] : undefined;
  const activeSourceId = activeSource?.id;

  const [bootstrapError, setBootstrapError] = useState<string>();
  const [dragActive, setDragActive] = useState(false);
  const [jobsOpen, setJobsOpen] = useState(false);
  const [workbooks, setWorkbooks] = useState<WorkbookSheets[]>([]);
  const [sheetBusy, setSheetBusy] = useState(false);
  const [retrySource, setRetrySource] = useState<SourceInfo>();
  const [retryBusy, setRetryBusy] = useState(false);
  const [gridViews, setGridViews] = useState<Record<string, GridViewState>>({});
  const [previewRowsBySource, setPreviewRowsBySource] = useState<Record<string, DataRow[]>>({});
  // Running state and errors are per SQL document so splits stay independent.
  const [runningDocuments, setRunningDocuments] = useState<Set<string>>(new Set());
  const [queryErrors, setQueryErrors] = useState<Record<string, string | undefined>>({});
  const [queryResultSourceIds, setQueryResultSourceIds] = useState<Record<string, string>>({});
  const [saveQueryDocumentId, setSaveQueryDocumentId] = useState<string>();
  const [saveQueryOpen, setSaveQueryOpen] = useState(false);
  const [saveQueryBusy, setSaveQueryBusy] = useState(false);
  const [saveResultOpen, setSaveResultOpen] = useState(false);
  const [saveResultBusy, setSaveResultBusy] = useState(false);
  const [saveResultSourceId, setSaveResultSourceId] = useState<string>();
  const [exportOpen, setExportOpen] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete>();
  const [pendingDetach, setPendingDetach] = useState<PendingDetach>();
  const [attachDialogOpen, setAttachDialogOpen] = useState(false);
  const [attachingConnectionId, setAttachingConnectionId] = useState<string>();
  const [connectionDialogOpen, setConnectionDialogOpen] = useState(false);
  const [editingConnection, setEditingConnection] = useState<ConnectionInfo>();
  const [connectionManagerOpen, setConnectionManagerOpen] = useState(false);
  const [projectManagerOpen, setProjectManagerOpen] = useState(false);
  const [projectManagerCreate, setProjectManagerCreate] = useState(false);
  const [catalogLoading, setCatalogLoading] = useState<Set<string>>(new Set());
  const [catalogErrors, setCatalogErrors] = useState<Record<string, string>>({});
  const importFailureToasts = useRef(new ImportFailureToastDeduper());
  const sidebarPanelRef = useRef<ImperativePanelHandle>(null);
  const queryResultSourceIdsRef = useRef<Record<string, string>>({});

  const attachQueryResult = useCallback((outputKey: string, sourceId: string): string | undefined => {
    const previous = queryResultSourceIdsRef.current[outputKey];
    const next = { ...queryResultSourceIdsRef.current, [outputKey]: sourceId };
    queryResultSourceIdsRef.current = next;
    setQueryResultSourceIds(next);
    return previous;
  }, []);

  const detachQueryResult = useCallback((outputKey: string): string | undefined => {
    const previous = queryResultSourceIdsRef.current[outputKey];
    if (!previous) return undefined;
    const next = { ...queryResultSourceIdsRef.current };
    delete next[outputKey];
    queryResultSourceIdsRef.current = next;
    setQueryResultSourceIds(next);
    return previous;
  }, []);

  const forgetQueryResultSource = useCallback((sourceId: string) => {
    const entries = Object.entries(queryResultSourceIdsRef.current).filter(([, attachedSourceId]) => attachedSourceId !== sourceId);
    if (entries.length === Object.keys(queryResultSourceIdsRef.current).length) return;
    const next = Object.fromEntries(entries);
    queryResultSourceIdsRef.current = next;
    setQueryResultSourceIds(next);
  }, []);

  const discardEphemeralResult = useCallback((projectId: string, sourceId?: string) => {
    if (!sourceId) return;
    const source = useAppStore.getState().projectWorkspaces[projectId]?.sourcesById[sourceId];
    if (!source?.isEphemeral) return;
    void bridge.CloseResult({ projectId, id: sourceId }).then(() => {
      const latest = useAppStore.getState().projectWorkspaces[projectId]?.sourcesById[sourceId];
      if (latest?.isEphemeral) useAppStore.getState().removeSource(projectId, sourceId);
    }).catch((error) => {
      const message = getErrorMessage(error);
      if (!/not found/i.test(message)) toast.error(projectToast(projectId, "Could not discard previous query output"), { description: message });
    });
  }, []);

  const toggleSidebar = useCallback(() => {
    const state = useAppStore.getState();
    const panel = sidebarPanelRef.current;
    if (!panel) {
      state.setPanel({ sidebarCollapsed: !state.panel.sidebarCollapsed });
      return;
    }
    if (panel.isCollapsed()) panel.expand(state.panel.sidebarSize);
    else panel.collapse();
  }, []);

  const closeTab = useCallback((tabId: string) => {
    const state = useAppStore.getState();
    const projectId = state.activeProjectId;
    const currentWorkspace = projectId ? state.projectWorkspaces[projectId] : undefined;
    const tab = currentWorkspace?.session.tabs.find((item) => item.id === tabId);
    const source = tab?.sourceId ? currentWorkspace?.sourcesById[tab.sourceId] : undefined;
    if (!projectId) return;
    if (tab?.documentId) {
      const outputKey = `${projectId}:${tab.documentId}`;
      discardEphemeralResult(projectId, detachQueryResult(outputKey));
    }
    // Discarding an ephemeral result drops a DuckDB table, so it needs a confirm.
    if (source?.isEphemeral) setPendingDelete({ kind: "result", projectId, id: source.id, name: source.displayName });
    else state.closeTab(projectId, tabId);
  }, [detachQueryResult, discardEphemeralResult]);

  const readySources = useMemo(() => sources.filter((source) => source.status === "ready"), [sources]);
  const autocompleteRelations = useMemo(() => workspace ? Object.values(workspace.catalog.relationsById).filter((relation) => relation.columns.length > 0 && store.connectionsById[relation.connectionId]?.status === "connected") : [], [store.connectionsById, workspace]);
  const activeJobs = useMemo(() => jobs.filter((job) => job.state === "queued" || job.state === "running"), [jobs]);
  const activeGridId = activeSource?.id ?? activeRelation?.id;
  const activeResource: GridResourceRef | undefined = activeSource ? { kind: "source", sourceId: activeSource.id } : activeRelation ? { kind: "external", relationId: activeRelation.id } : undefined;
  const saveQueryDocument = workspace && saveQueryDocumentId ? workspace.session.documents.find((document) => document.id === saveQueryDocumentId) : undefined;
  const saveQuerySavedName = saveQueryDocument?.savedQueryId ? workspace?.savedQueriesById[saveQueryDocument.savedQueryId]?.name : undefined;
  const activeWorkbook = activeProjectId ? workbooks.find((workbook) => workbook.projectId === activeProjectId) : undefined;
  const unattachedConnections = useMemo(() => globalConnections.filter((connection) => !workspace?.connectionIds.includes(connection.id)), [globalConnections, workspace]);
  const displayTabs = useMemo(() => (workspace?.session.tabs ?? []).map((tab) => {
    if (!tab.relationId) return tab;
    const relation = workspace?.catalog.relationsById[tab.relationId];
    const connectionId = relation?.connectionId ?? tab.connectionId;
    if (!connectionId || store.connectionsById[connectionId]?.status !== "connected") return { ...tab, kind: "placeholder" as const, placeholderReason: "disconnected" as const };
    return tab;
  }), [store.connectionsById, workspace]);
  const tabsById = useMemo(() => Object.fromEntries(displayTabs.map((tab) => [tab.id, tab])), [displayTabs]);

  const closeProjectDialogs = useCallback(() => {
    setWorkbooks([]);
    setRetrySource(undefined);
    setSaveQueryOpen(false);
    setSaveResultOpen(false);
    setSaveResultSourceId(undefined);
    setExportOpen(false);
    setPendingDelete(undefined);
    setPendingDetach(undefined);
    setAttachDialogOpen(false);
    setConnectionDialogOpen(false);
    setEditingConnection(undefined);
    setProjectManagerOpen(false);
    setConnectionManagerOpen(false);
  }, []);

  const flushForDialog = useCallback((close: () => void) => {
    const projectId = useAppStore.getState().activeProjectId;
    if (!projectId) { close(); return; }
    void flushStoredProjectSession(projectId).catch((error) => {
      toast.error(`Could not save ${projectName(projectId)} session`, { description: getErrorMessage(error) });
    }).finally(close);
  }, []);

  const switchProject = useCallback(async (projectId: string) => {
    const state = useAppStore.getState();
    const previousProjectId = state.activeProjectId;
    const targetAtStart = state.projectWorkspaces[projectId];
    const connectionsAtStart = state.connectionsById;
    if (projectId === previousProjectId || state.switchingProjectId) return;
    if (previousProjectId) {
      try { await flushStoredProjectSession(previousProjectId); }
      catch (error) {
        toast.error(`Could not switch projects because ${projectName(previousProjectId)} was not saved`, { description: getErrorMessage(error) });
        return;
      }
    }
    closeProjectDialogs();
    useAppStore.getState().startProjectSwitch(projectId);
    try {
      let nextWorkspace = await bridge.OpenProject(projectId);
      if (nextWorkspace.project.id !== projectId) throw new Error("The backend returned a different project workspace.");
      markProjectSessionSaved(projectId, nextWorkspace.session);
      const latestState = useAppStore.getState();
      const latestTarget = latestState.projectWorkspaces[projectId];
      if (targetAtStart && latestTarget && latestTarget !== targetAtStart) {
        nextWorkspace = preserveWorkspaceMutations(nextWorkspace, latestTarget, latestState.connectionsById);
      } else if (latestState.connectionsById !== connectionsAtStart) {
        nextWorkspace = {
          ...nextWorkspace,
          connections: nextWorkspace.connections.map((connection) => latestState.connectionsById[connection.id] ?? connection),
        };
      }
      if (!useAppStore.getState().commitProjectSwitch(projectId, nextWorkspace)) return;
      for (const warning of nextWorkspace.warnings ?? []) toast.warning(projectToast(projectId, warning.message));
    } catch (error) {
      useAppStore.getState().cancelProjectSwitch(projectId);
      toast.error(`Could not open ${projectName(projectId)}`, { description: getErrorMessage(error) });
    }
  }, [closeProjectDialogs]);

  const notifyImportFailure = useCallback((projectId: string, sourceId: string, error: AppErrorInfo, fallbackMessage: string, stage?: string) => {
    if (!importFailureToasts.current.shouldNotify(projectId, sourceId)) return;
    const presented = presentAppError(error, fallbackMessage, stage);
    toast.error(projectToast(projectId, presented.message), {
      id: `import-failure:${projectId}:${sourceId}`,
      description: appErrorToastDescription(presented),
    });
  }, []);

  const renameSource = useCallback(async (source: SourceInfo, displayName: string) => {
    try {
      const renamed = await bridge.RenameSource({ projectId: source.projectId, id: source.id, displayName });
      useAppStore.getState().upsertSource(source.projectId, renamed);
      toast.success(`${source.displayName} renamed`, { description: displayName });
    } catch (error) {
      toast.error(`Could not rename ${source.displayName}`, { description: getErrorMessage(error) });
      throw error;
    }
  }, []);

  const renameSavedQuery = useCallback(async (query: SavedQuery, name: string) => {
    try {
      const renamed = await bridge.SaveQuery({ projectId: query.projectId, id: query.id, name, sql: query.sql });
      useAppStore.getState().upsertSavedQuery(query.projectId, renamed);
      toast.success(projectToast(query.projectId, `Renamed query to “${renamed.name}”`));
    } catch (error) {
      toast.error(projectToast(query.projectId, `Could not rename ${query.name}`), { description: getErrorMessage(error) });
      throw error;
    }
  }, []);

  const quickRemoveSource = useCallback(async (source: SourceInfo) => {
    try {
      await bridge.RemoveDataset({ projectId: source.projectId, id: source.id });
      useAppStore.getState().removeSource(source.projectId, source.id);
      forgetQueryResultSource(source.id);
      setPreviewRowsBySource((rows) => {
        const next = { ...rows };
        delete next[`${source.projectId}:${source.id}`];
        return next;
      });
      toast.success(projectToast(source.projectId, `Removed “${source.displayName}”`), { description: "Only the local table was deleted; original files and remote data were not modified." });
    } catch (error) {
      toast.error(projectToast(source.projectId, `Could not remove ${source.displayName}`), { description: getErrorMessage(error) });
      throw error;
    }
  }, [forgetQueryResultSource]);

  const copySourceQuery = useCallback(async (source: SourceInfo) => {
    if (!source.originalSQL) return;
    if (!navigator.clipboard?.writeText) {
      toast.error("Clipboard is unavailable");
      return;
    }
    try {
      await navigator.clipboard.writeText(source.originalSQL);
      toast.success("Source query copied");
    } catch (error) {
      toast.error("Could not copy source query", { description: getErrorMessage(error) });
    }
  }, []);

  const handleBatch = useCallback((projectId: string, batch: ImportPathsResult | ImportStartResult) => {
    const actions = useAppStore.getState();
    for (const rawSource of batch.sources ?? []) {
      if (Array.isArray(rawSource.previewRows)) setPreviewRowsBySource((current) => ({ ...current, [`${projectId}:${rawSource.id}`]: rawSource.previewRows! }));
      const source = normalizeSource(rawSource, projectId);
      actions.upsertSource(projectId, source);
      if (actions.activeProjectId === projectId) actions.openTab(projectId, source.id);
      if (source.status === "failed") {
        notifyImportFailure(projectId, source.id, source.error ?? { message: `Could not import ${source.displayName}` }, `Could not import ${source.displayName}`);
      }
    }
    for (const job of batch.jobs ?? []) actions.upsertJob(projectId, job);
    if ("workbooks" in batch && batch.workbooks?.length && actions.activeProjectId === projectId) {
      setWorkbooks((current) => [...current, ...batch.workbooks!.map((workbook) => ({ ...workbook, projectId }))]);
    }
  }, [notifyImportFailure]);

  const importPaths = useCallback(async (paths: string[], options?: ImportOptions, requestedProjectId?: string) => {
    const projectId = requestedProjectId ?? useAppStore.getState().activeProjectId;
    if (!projectId || !paths.length) return;
    try { handleBatch(projectId, await bridge.ImportPaths({ projectId, paths, options })); }
    catch (error) { toast.error(projectToast(projectId, getErrorMessage(error))); }
  }, [handleBatch]);

  const openFiles = useCallback(async () => {
    const projectId = useAppStore.getState().activeProjectId;
    if (!projectId) return;
    try {
      const result = await bridge.OpenFiles(projectId);
      if (!result) return;
      if (Array.isArray(result)) await importPaths(result, undefined, projectId);
      else handleBatch(projectId, result);
    } catch (error) { toast.error(projectToast(projectId, getErrorMessage(error))); }
  }, [handleBatch, importPaths]);

  useEffect(() => {
    let alive = true;
    try { localStorage.removeItem("ducs-table:preferences:v1"); } catch { /* unavailable webview storage is non-fatal */ }
    void bridge.Bootstrap().then(async (state) => {
      if (!alive) return;
      if (state.workspace) markProjectSessionSaved(state.workspace.project.id, state.workspace.session);
      useAppStore.getState().bootstrap(state);
      for (const warning of state.workspace?.warnings ?? []) toast.warning(projectToast(state.workspace!.project.id, warning.message));
      if (state.activeProjectId && !state.workspace) {
        useAppStore.getState().startProjectSwitch(state.activeProjectId);
        const opened = await bridge.OpenProject(state.activeProjectId);
        if (!alive) return;
        markProjectSessionSaved(state.activeProjectId, opened.session);
        useAppStore.getState().commitProjectSwitch(state.activeProjectId, opened);
      }
      try {
        const globals = await bridge.ListGlobalConnections();
        if (alive) {
          const actions = useAppStore.getState();
          actions.setGlobalConnections(globals);
          for (const connection of globals) {
            if (connection.status !== "connected") continue;
            for (const [projectId, projectWorkspace] of Object.entries(actions.projectWorkspaces)) {
              if (projectWorkspace.connectionIds.includes(connection.id)) void validateExternalTabs(projectId, connection);
            }
          }
        }
      } catch (error) {
        if (alive) toast.error("Could not list global connections", { description: getErrorMessage(error) });
      }
    }).catch((error) => {
      if (!alive) return;
      setBootstrapError(getErrorMessage(error));
      useAppStore.getState().bootstrap({ projects: [], jobs: [], ready: false });
    });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    return useAppStore.subscribe((state, previous) => {
      for (const [projectId, projectWorkspace] of Object.entries(state.projectWorkspaces)) {
        if (projectWorkspace.session === previous.projectWorkspaces[projectId]?.session) continue;
        scheduleProjectSessionSave(projectId, projectWorkspace.session, (error) => {
          toast.error(`Could not save ${projectName(projectId)} session`, { description: getErrorMessage(error) });
        });
      }
    });
  }, []);

  useEffect(() => {
    const unload = () => {
      const projectId = useAppStore.getState().activeProjectId;
      const activeFlush = projectId ? flushStoredProjectSession(projectId) : Promise.resolve();
      void activeFlush.then(flushAllProjectSessions).catch(() => undefined);
    };
    window.addEventListener("beforeunload", unload);
    return () => {
      window.removeEventListener("beforeunload", unload);
      unload();
    };
  }, []);

  // Workbench shortcuts. Cmd/Ctrl+Enter stays inside the editor component so
  // it always runs the document the caret is in.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      const state = useAppStore.getState();
      const projectId = state.activeProjectId;
      const session = projectId ? state.projectWorkspaces[projectId]?.session : undefined;
      if (!projectId || !session) return;
      const groupId = session.activeGroupId;
      const key = event.key.toLowerCase();

      if (key === "t") {
        event.preventDefault();
        state.openSQLTab(projectId, { groupId });
        return;
      }
      if (key === "w") {
        const tabId = session.groups.find((group) => group.id === groupId)?.activeTabId;
        if (!tabId) return;
        event.preventDefault();
        closeTab(tabId);
        return;
      }
      if (key === "\\") {
        event.preventDefault();
        state.splitGroup(projectId, groupId, event.shiftKey ? "vertical" : "horizontal");
        return;
      }
      if (key === "b") {
        event.preventDefault();
        toggleSidebar();
        return;
      }
      if (/^[1-9]$/.test(key)) {
        const ordered = listGroupIds(session.layout);
        const target = ordered[Number(key) - 1];
        if (!target) return;
        event.preventDefault();
        state.setActiveGroup(projectId, target);
        return;
      }
      if (event.shiftKey && (event.key === "[" || event.key === "]" || key === "braceleft" || key === "braceright")) {
        const group = session.groups.find((item) => item.id === groupId);
        if (!group || group.tabIds.length < 2 || !group.activeTabId) return;
        event.preventDefault();
        const index = group.tabIds.indexOf(group.activeTabId);
        const offset = event.key === "]" ? 1 : -1;
        const next = group.tabIds[(index + offset + group.tabIds.length) % group.tabIds.length];
        state.selectTab(projectId, next);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeTab, toggleSidebar]);

  const setCatalogBusy = (key: string, busy: boolean) => setCatalogLoading((current) => {
    const next = new Set(current);
    if (busy) next.add(key); else next.delete(key);
    return next;
  });

  const loadSchemasFor = async (projectId: string, connection: ConnectionInfo, force = false) => {
    const currentWorkspace = useAppStore.getState().projectWorkspaces[projectId];
    if (connection.status !== "connected" || (!force && currentWorkspace?.catalog.schemasByConnection[connection.id])) return;
    const busyKey = `${projectId}:${connection.id}`;
    setCatalogBusy(busyKey, true);
    setCatalogErrors((current) => ({ ...current, [busyKey]: "" }));
    try {
      const schemas = await bridge.ListConnectionSchemas({ projectId, id: connection.id });
      useAppStore.getState().setConnectionSchemas(projectId, connection.id, schemas.map((schema) => schema.name));
    } catch (error) {
      setCatalogErrors((current) => ({ ...current, [busyKey]: getErrorMessage(error) }));
    } finally { setCatalogBusy(busyKey, false); }
  };

  const loadSchemas = async (connection: ConnectionInfo, force = false) => {
    const projectId = useAppStore.getState().activeProjectId;
    if (projectId) await loadSchemasFor(projectId, connection, force);
  };

  const loadRelations = async (connection: ConnectionInfo, schema: string, force = false) => {
    const projectId = useAppStore.getState().activeProjectId;
    if (!projectId) return;
    const currentWorkspace = useAppStore.getState().projectWorkspaces[projectId];
    const catalogKey = `${connection.id}:${schema}`;
    if (connection.status !== "connected" || (!force && currentWorkspace?.catalog.relationsBySchema[catalogKey])) return;
    const busyKey = `${projectId}:${catalogKey}`;
    setCatalogBusy(busyKey, true);
    setCatalogErrors((current) => ({ ...current, [busyKey]: "" }));
    try {
      const relations = await bridge.ListExternalRelations({ projectId, connectionId: connection.id, schema });
      const removed = useAppStore.getState().setExternalRelations(projectId, connection.id, schema, relations);
      for (const tab of removed) toast.warning(projectToast(projectId, `“${tab.title}” no longer exists and its tab was closed.`));
    } catch (error) {
      setCatalogErrors((current) => ({ ...current, [busyKey]: getErrorMessage(error) }));
    } finally { setCatalogBusy(busyKey, false); }
  };

  const connectDatabase = async (connection: ConnectionInfo) => {
    const projectId = useAppStore.getState().activeProjectId;
    if (!projectId) return;
    try {
      const connected = await bridge.ConnectConnection({ projectId, id: connection.id });
      useAppStore.getState().upsertConnection(connected);
      toast.success(projectToast(projectId, `${connected.name} connected`));
      await loadSchemasFor(projectId, connected, true);
      await validateExternalTabs(projectId, connected);
    } catch (error) { toast.error(projectToast(projectId, "Connection failed"), { description: getErrorMessage(error) }); }
  };

  const disconnectDatabase = async (connection: ConnectionInfo) => {
    const projectId = useAppStore.getState().activeProjectId;
    if (!projectId) return;
    try {
      await bridge.DisconnectConnection({ projectId, id: connection.id });
      useAppStore.getState().upsertConnection({ ...connection, status: "disconnected", lastError: undefined });
      const tabs = useAppStore.getState().projectWorkspaces[projectId]?.session.tabs ?? [];
      for (const tab of tabs) if (tab.connectionId === connection.id && tab.relationId) useAppStore.getState().markExternalPlaceholder(projectId, tab.relationId, "disconnected");
      toast.success(projectToast(projectId, `${connection.name} disconnected`));
    } catch (error) { toast.error(projectToast(projectId, getErrorMessage(error))); }
  };

  const reconnectDatabase = async (connection: ConnectionInfo) => {
    const projectId = useAppStore.getState().activeProjectId;
    if (!projectId) return;
    try { await bridge.DisconnectConnection({ projectId, id: connection.id }); } catch { /* stale pools may already be gone */ }
    if (useAppStore.getState().activeProjectId === projectId) await connectDatabase({ ...connection, status: "disconnected" });
  };

  const refreshCatalog = async (connection: ConnectionInfo) => {
    const projectId = useAppStore.getState().activeProjectId;
    if (!projectId) return;
    try {
      await bridge.RefreshConnectionCatalog({ projectId, id: connection.id });
      useAppStore.getState().invalidateCatalog(projectId, connection.id);
      await loadSchemasFor(projectId, { ...connection, status: "connected" }, true);
      toast.success(projectToast(projectId, `${connection.name} catalog refreshed`));
    } catch (error) { toast.error(projectToast(projectId, getErrorMessage(error))); }
  };

  const openExternalRelation = async (relation: ExternalRelationInfo) => {
    const projectId = useAppStore.getState().activeProjectId;
    if (!projectId) return;
    const connection = useAppStore.getState().connectionsById[relation.connectionId];
    if (!connection || connection.status !== "connected") { toast.error("Connect the database before opening this live relation."); return; }
    try {
      const detailed = await bridge.GetExternalRelation({ projectId, id: relation.id });
      useAppStore.getState().upsertExternalRelation(projectId, detailed);
      if (useAppStore.getState().activeProjectId === projectId) useAppStore.getState().openExternalTab(projectId, detailed);
    } catch (error) { toast.error(projectToast(projectId, getErrorMessage(error))); }
  };

  const snapshotRelation = async (relation: ExternalRelationInfo) => {
    const projectId = useAppStore.getState().activeProjectId;
    if (!projectId) return;
    try {
      const job = await bridge.SnapshotExternalRelation({ projectId, relationId: relation.id });
      useAppStore.getState().upsertJob(projectId, job);
      toast.success(projectToast(projectId, "Snapshot started"), { description: "The live relation is being copied atomically." });
    } catch (error) { toast.error(projectToast(projectId, getErrorMessage(error))); }
  };

  const refreshLocalSnapshot = async (source: SourceInfo) => {
    const projectId = source.projectId;
    try {
      const job = await bridge.RefreshSnapshot({ projectId, sourceId: source.id });
      useAppStore.getState().upsertJob(projectId, job);
      toast.success(projectToast(projectId, "Snapshot refresh started"), { description: "The current local version remains available until replacement succeeds." });
    } catch (error) { toast.error(projectToast(projectId, getErrorMessage(error))); }
  };

  useEffect(() => {
    if (!activeProjectId || !activeTab?.relationId || activeRelation) return;
    const projectId = activeProjectId;
    const relationId = activeTab.relationId;
    const connection = activeTab.connectionId ? useAppStore.getState().connectionsById[activeTab.connectionId] : undefined;
    if (connection && connection.status !== "connected") {
      if (activeTab.kind !== "placeholder" || activeTab.placeholderReason !== "disconnected") useAppStore.getState().markExternalPlaceholder(projectId, relationId, "disconnected");
      return;
    }
    let alive = true;
    void bridge.GetExternalRelation({ projectId, id: relationId }).then((relation) => {
      if (alive) useAppStore.getState().upsertExternalRelation(projectId, relation);
    }).catch((error) => {
      if (!alive) return;
      if (missingExternalRelation(error)) {
        useAppStore.getState().closeTab(projectId, activeTab.id);
        toast.warning(projectToast(projectId, `“${activeTab.title}” no longer exists and its tab was closed.`));
      } else {
        useAppStore.getState().markExternalPlaceholder(projectId, relationId, "disconnected");
        toast.warning(projectToast(projectId, `“${activeTab.title}” could not be validated yet and remains available.`));
      }
    });
    return () => { alive = false; };
  }, [activeProjectId, activeRelation, activeTab]);

  useEffect(() => {
    const unsubscribers = [
      bridge.on("ducs:job-updated", (job) => {
        const actions = useAppStore.getState();
        if (!job.projectId) return;
        actions.upsertJob(job.projectId, job);
        if (job.kind === "import" && job.sourceId && job.state === "cancelled") {
          const source = actions.projectWorkspaces[job.projectId]?.sourcesById[job.sourceId];
          if (source && source.status !== "ready") actions.upsertSource(job.projectId, { ...source, status: "cancelled" });
        }
        if (job.state === "failed") {
          if (job.kind === "import" && job.sourceId) {
            notifyImportFailure(job.projectId, job.sourceId, job.error ?? { message: `${job.kind} failed` }, `${job.kind} failed`, job.stage);
          } else {
            toast.error(projectToast(job.projectId, job.error?.message ?? `${job.kind} failed`));
          }
        }
      }),
      bridge.on("ducs:dataset-preview", ({ projectId, source }) => {
        if (!projectId) return;
        if (Array.isArray(source.previewRows)) setPreviewRowsBySource((current) => ({ ...current, [`${projectId}:${source.id}`]: source.previewRows! }));
        const actions = useAppStore.getState();
        actions.upsertSource(projectId, source);
        if (actions.activeProjectId === projectId) actions.openTab(projectId, source.id);
      }),
      bridge.on("ducs:dataset-ready", ({ projectId, source: raw }) => {
        if (!projectId) return;
        const source = { ...normalizeSource(raw, projectId), status: "ready" as const };
        importFailureToasts.current.reset(projectId, source.id);
        setPreviewRowsBySource((current) => {
          const next = { ...current };
          delete next[`${projectId}:${source.id}`];
          return next;
        });
        useAppStore.getState().upsertSource(projectId, source);
        toast.success(projectToast(projectId, `${source.displayName} is ready`), { description: `${source.rowCount?.toLocaleString() ?? "0"} rows · ${source.tableName}` });
      }),
      bridge.on("ducs:dataset-failed", (payload) => {
        const actions = useAppStore.getState();
        const current = actions.projectWorkspaces[payload.projectId]?.sourcesById[payload.sourceId];
        if (!current) return;
        const cancelled = payload.error.code === "CANCELLED" || payload.error.code === "JOB_CANCELLED";
        setPreviewRowsBySource((rows) => {
          const next = { ...rows };
          delete next[`${payload.projectId}:${payload.sourceId}`];
          return next;
        });
        actions.upsertSource(payload.projectId, { ...current, status: cancelled ? "cancelled" : "failed", error: payload.error });
        if (!cancelled) notifyImportFailure(payload.projectId, payload.sourceId, payload.error, `Could not import ${current.displayName}`);
      }),
      bridge.on("ducs:result-ready", ({ projectId, source: raw }) => {
        if (!projectId) return;
        const actions = useAppStore.getState();
        const normalized = normalizeSource(raw, projectId);
        const existing = actions.projectWorkspaces[projectId]?.sourcesById[normalized.id];
        const source = { ...normalized, displayName: existing?.displayName ?? normalized.displayName, status: "ready" as const };
        actions.upsertSource(projectId, source);
      }),
      bridge.on("ducs:file-drop", (payload) => {
        // Wails may surface an internal HTML tab drag as an empty native drop.
        // The bridge removes blank paths; an empty payload is not an import.
        if (payload.paths.length === 0) {
          setDragActive(false);
          return;
        }
        const projectId = payload.projectId ?? useAppStore.getState().activeProjectId;
        if (projectId) void importPaths(payload.paths, undefined, projectId);
        setDragActive(false);
      }),
      bridge.on("ducs:connection-updated", (connection) => {
        const actions = useAppStore.getState();
        actions.upsertConnection(connection);
        for (const [projectId, projectWorkspace] of Object.entries(actions.projectWorkspaces)) {
          if (!projectWorkspace.connectionIds.includes(connection.id)) continue;
          if (connection.status === "connected") {
            void validateExternalTabs(projectId, connection);
          } else if (connection.status === "disconnected" || connection.status === "error") {
            for (const tab of projectWorkspace.session.tabs) {
              if (tab.connectionId === connection.id && tab.relationId) actions.markExternalPlaceholder(projectId, tab.relationId, "disconnected");
            }
          }
        }
        if (connection.status === "error" && connection.lastError) toast.error(`${connection.name}: ${connection.lastError.message}`);
      }),
      bridge.on("ducs:ai-stream", (payload) => useAIStore.getState().handleStream(payload)),
      bridge.on("ducs:ai-runtime", (run) => useAIStore.getState().handleRuntime(run)),
      bridge.on("ducs:ai-approval-request", (approval) => useAIStore.getState().handleApproval(approval)),
      bridge.on("ducs:ai-provider-updated", (update) => {
        if (update.provider) {
          useAIStore.getState().handleProviderUpdate(update.provider, update);
          if (update.method === "provider.login.completed") {
            void useAIStore.getState().refreshProvider(update.provider).catch(() => undefined);
          }
        }
      }),
      bridge.on("ducs:catalog-invalidated", ({ projectId, connectionId }) => {
        if (projectId) useAppStore.getState().invalidateCatalog(projectId, connectionId);
      }),
      bridge.on("ducs:snapshot-ready", ({ projectId, source: raw }) => {
        if (!projectId) return;
        const source = { ...normalizeSource(raw, projectId), status: "ready" as const };
        useAppStore.getState().upsertSource(projectId, source);
        toast.success(projectToast(projectId, `${source.displayName} snapshot is ready`));
      }),
      bridge.on("ducs:snapshot-failed", (payload) => {
        if (payload.error.code !== "CANCELLED") toast.error(projectToast(payload.projectId, "Snapshot failed"), { description: payload.error.message });
      }),
    ];
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, [importPaths, notifyImportFailure]);

  useEffect(() => {
    const enter = (event: DragEvent) => {
      if (!isFileDrag(event.dataTransfer)) return;
      event.preventDefault();
      setDragActive(true);
    };
    const over = (event: DragEvent) => {
      if (isFileDrag(event.dataTransfer)) event.preventDefault();
    };
    const leave = (event: DragEvent) => {
      if (isFileDrag(event.dataTransfer) && !event.relatedTarget) setDragActive(false);
    };
    const drop = (event: DragEvent) => {
      if (!isFileDrag(event.dataTransfer)) return;
      event.preventDefault();
      setDragActive(false);
    };
    document.addEventListener("dragenter", enter);
    document.addEventListener("dragover", over);
    document.addEventListener("dragleave", leave);
    document.addEventListener("drop", drop);
    return () => {
      document.removeEventListener("dragenter", enter);
      document.removeEventListener("dragover", over);
      document.removeEventListener("dragleave", leave);
      document.removeEventListener("drop", drop);
    };
  }, []);

  /**
   * Runs one SQL document and atomically swaps its attached output. The old
   * result remains visible until a new execution succeeds.
   */
  const runQuery = async (options: { documentId?: string; sql?: string } = {}) => {
    const state = useAppStore.getState();
    const projectId = state.activeProjectId;
    const session = projectId ? state.projectWorkspaces[projectId]?.session : undefined;
    if (!projectId || !session) return;
    const documentId = options.documentId ?? focusedDocumentId(session);
    const document = documentId ? session.documents.find((item) => item.id === documentId) : undefined;
    const sql = options.sql ?? document?.sql;
    if (!sql?.trim()) return;
    const runKey = documentId ?? projectId;
    if (runningDocuments.has(runKey)) return;
    const ownerGroupId = documentId
      ? session.groups.find((group) => group.tabIds.some((tabId) => session.tabs.find((tab) => tab.id === tabId)?.documentId === documentId))?.id
      : undefined;

    setRunningDocuments((current) => new Set(current).add(runKey));
    setQueryErrors((current) => ({ ...current, [runKey]: undefined }));
    const started = performance.now();
    try {
      const result = await bridge.RunQuery({ projectId, sql });
      const source = { ...normalizeSource(result.source, projectId), displayName: useAppStore.getState().nextResultName(projectId), status: "ready" as const };
      const actions = useAppStore.getState();
      actions.upsertSource(projectId, source);
      const documentStillOpen = Boolean(documentId && actions.projectWorkspaces[projectId]?.session.documents.some((item) => item.id === documentId));
      if (documentId && documentStillOpen) {
        // Swap only after a successful execution. On failure the previous
        // output remains attached and visible to the query.
        const previousSourceId = attachQueryResult(`${projectId}:${documentId}`, source.id);
        if (previousSourceId !== source.id) discardEphemeralResult(projectId, previousSourceId);
        if (actions.activeProjectId === projectId && ownerGroupId) actions.setActiveGroup(projectId, ownerGroupId);
      } else {
        // The query may have been closed while DuckDB was still executing.
        discardEphemeralResult(projectId, source.id);
      }
      actions.addHistory(projectId, { sql, status: "success", durationMs: result.durationMs ?? Math.round(performance.now() - started) });
      toast.success(projectToast(projectId, `${source.displayName} created`), { description: `${result.rowCount ?? source.rowCount ?? 0} rows in ${result.durationMs ?? Math.round(performance.now() - started)}ms` });
    } catch (error) {
      const message = getErrorMessage(error);
      if (useAppStore.getState().activeProjectId === projectId) setQueryErrors((current) => ({ ...current, [runKey]: message }));
      useAppStore.getState().addHistory(projectId, { sql, status: "error", durationMs: Math.round(performance.now() - started) });
      toast.error(projectToast(projectId, "Query failed"), { description: message });
    } finally {
      setRunningDocuments((current) => {
        const next = new Set(current);
        next.delete(runKey);
        return next;
      });
    }
  };

  const saveQuery = async (name: string) => {
    const state = useAppStore.getState();
    const projectId = state.activeProjectId;
    const session = projectId ? state.projectWorkspaces[projectId]?.session : undefined;
    const documentId = saveQueryDocumentId ?? (session ? focusedDocumentId(session) : undefined);
    const document = session && documentId ? session.documents.find((item) => item.id === documentId) : undefined;
    if (!projectId || !document) return;
    setSaveQueryBusy(true);
    try {
      const saved = await bridge.SaveQuery({ projectId, id: document.savedQueryId, name, sql: document.sql });
      useAppStore.getState().upsertSavedQuery(projectId, saved);
      useAppStore.getState().bindSavedQuery(projectId, document.id, saved);
      await flushStoredProjectSession(projectId);
      setSaveQueryOpen(false);
      setSaveQueryDocumentId(undefined);
      toast.success(projectToast(projectId, `Saved query “${saved.name}”`));
    } catch (error) { toast.error(projectToast(projectId, getErrorMessage(error))); }
    finally { setSaveQueryBusy(false); }
  };

  const saveResult = async (name: string) => {
    const state = useAppStore.getState();
    const projectId = state.activeProjectId;
    const source = projectId && saveResultSourceId ? state.projectWorkspaces[projectId]?.sourcesById[saveResultSourceId] : undefined;
    if (!projectId || !source?.isEphemeral) return;
    setSaveResultBusy(true);
    try {
      const saved = normalizeSource(await bridge.SaveResultAsTable({ projectId, resultId: source.id, displayName: name }), projectId);
      useAppStore.getState().upsertSource(projectId, { ...saved, status: "ready" });
      await flushStoredProjectSession(projectId);
      setSaveResultOpen(false);
      setSaveResultSourceId(undefined);
      toast.success(projectToast(projectId, `Saved as ${saved.tableName}`));
    } catch (error) { toast.error(projectToast(projectId, getErrorMessage(error))); }
    finally { setSaveResultBusy(false); }
  };

  const exportCSV = async (scope: "entire" | "current-view") => {
    const projectId = useAppStore.getState().activeProjectId;
    if (!projectId || !activeResource || !activeGridId) return;
    const columns = activeSource?.columns ?? activeRelation?.columns ?? [];
    const viewKey = `${projectId}:${activeResource.kind}:${activeGridId}`;
    const view = gridViews[viewKey] ?? { ...emptyView, visibleColumns: columns.map((column) => column.name) };
    if (scope === "current-view" && view.visibleColumns.length === 0) { toast.error("Show at least one column before exporting the current view."); return; }
    setExportBusy(true);
    try {
      const result = await bridge.ExportCSV({ projectId, resource: activeResource, scope, filters: scope === "current-view" ? view.filters : undefined, sorts: scope === "current-view" ? view.sorts : undefined, visibleColumns: scope === "current-view" ? view.visibleColumns : undefined });
      await flushStoredProjectSession(projectId);
      setExportOpen(false);
      toast.success(projectToast(projectId, "CSV exported"), { description: result.path });
    } catch (error) {
      const message = getErrorMessage(error);
      if (!/cancel/i.test(message)) toast.error(projectToast(projectId, "Export failed"), { description: message });
    } finally { setExportBusy(false); }
  };

  const cancelJob = async (job: Job) => {
    const projectId = job.projectId;
    try {
      const cancelledJob = await bridge.CancelJob(job.id);
      useAppStore.getState().upsertJob(projectId, cancelledJob);
      const source = job.kind === "import" && job.sourceId ? useAppStore.getState().projectWorkspaces[projectId]?.sourcesById[job.sourceId] : undefined;
      if (source && cancelledJob.state === "cancelled") useAppStore.getState().upsertSource(projectId, { ...source, status: "cancelled" });
    } catch (error) { toast.error(projectToast(projectId, getErrorMessage(error))); }
  };

  const confirmDelete = async () => {
    const pending = pendingDelete;
    if (!pending) return;
    setPendingDelete(undefined);
    try {
      if (pending.kind === "result") {
        await bridge.CloseResult({ projectId: pending.projectId, id: pending.id });
        useAppStore.getState().removeSource(pending.projectId, pending.id);
      } else if (pending.kind === "dataset") {
        await bridge.RemoveDataset({ projectId: pending.projectId, id: pending.id });
        useAppStore.getState().removeSource(pending.projectId, pending.id);
      } else {
        await bridge.DeleteSavedQuery({ projectId: pending.projectId, id: pending.id });
        useAppStore.getState().removeSavedQuery(pending.projectId, pending.id);
      }
      setPreviewRowsBySource((rows) => {
        const next = { ...rows };
        delete next[`${pending.projectId}:${pending.id}`];
        return next;
      });
      forgetQueryResultSource(pending.id);
      toast.success(projectToast(pending.projectId, pending.kind === "query" ? "Saved query removed" : "Source removed"));
    } catch (error) { toast.error(projectToast(pending.projectId, getErrorMessage(error))); }
  };

  const retryImport = async (options: ImportOptions) => {
    const source = retrySource;
    if (!source?.sourcePath) return;
    const projectId = source.projectId;
    setRetryBusy(true);
    try {
      const batch = await bridge.ImportPaths({ projectId, paths: [source.sourcePath], options });
      useAppStore.getState().removeSource(projectId, source.id);
      handleBatch(projectId, batch);
      setRetrySource(undefined);
    } catch (error) { toast.error(projectToast(projectId, getErrorMessage(error))); }
    finally { setRetryBusy(false); }
  };

  const chooseSheet = async (sheet: string) => {
    const workbook = activeWorkbook;
    if (!workbook) return;
    const projectId = workbook.projectId;
    setSheetBusy(true);
    try {
      handleBatch(projectId, await bridge.StartXLSXImport({ projectId, path: workbook.path, sheets: [sheet], options: {} }));
      setWorkbooks((items) => items.filter((item) => item !== workbook));
    } catch (error) { toast.error(projectToast(projectId, getErrorMessage(error))); }
    finally { setSheetBusy(false); }
  };

  const attachConnection = async (connection: ConnectionInfo) => {
    const projectId = useAppStore.getState().activeProjectId;
    if (!projectId) return;
    setAttachingConnectionId(connection.id);
    try {
      const attached = await bridge.AttachConnectionToProject({ projectId, connectionId: connection.id });
      if (attached) useAppStore.getState().upsertConnection(attached);
      useAppStore.getState().attachConnection(projectId, connection.id);
      toast.success(projectToast(projectId, `${connection.name} attached`));
    } catch (error) { toast.error(projectToast(projectId, getErrorMessage(error))); }
    finally { setAttachingConnectionId(undefined); }
  };

  const detachConnection = async () => {
    const pending = pendingDetach;
    if (!pending) return;
    setPendingDetach(undefined);
    try {
      await bridge.DetachConnectionFromProject({ projectId: pending.projectId, connectionId: pending.connection.id });
      useAppStore.getState().detachConnection(pending.projectId, pending.connection.id);
      toast.success(projectToast(pending.projectId, `${pending.connection.name} removed from project`));
    } catch (error) { toast.error(projectToast(pending.projectId, getErrorMessage(error))); }
  };

  const deleteGlobalConnection = useCallback(async (connection: ConnectionInfo) => {
    await bridge.DeleteConnection(connection.id);
    useAppStore.getState().removeConnectionEverywhere(connection.id);
    toast.success(`${connection.name} deleted everywhere; local snapshots were preserved`);
  }, []);

  const connectionUsage = useCallback((connectionId: string) => bridge.ConnectionUsageCount(connectionId), []);

  const createProject = async (input: { name: string; description: string }) => {
    const previousProjectId = useAppStore.getState().activeProjectId;
    if (previousProjectId) await flushStoredProjectSession(previousProjectId);
    const project = await bridge.CreateProject(input);
    useAppStore.getState().upsertProject(project);
    useAppStore.getState().startProjectSwitch(project.id);
    const nextWorkspace = await bridge.OpenProject(project.id);
    if (nextWorkspace.project.id !== project.id) throw new Error("The backend returned a different project workspace.");
    markProjectSessionSaved(project.id, nextWorkspace.session);
    useAppStore.getState().commitProjectSwitch(project.id, nextWorkspace);
    for (const warning of nextWorkspace.warnings ?? []) toast.warning(projectToast(project.id, warning.message));
    closeProjectDialogs();
    toast.success(`Project “${project.name}” created`);
  };

  const updateProject = async (input: { projectId: string; name: string; description: string }) => {
    const project = await bridge.UpdateProject(input);
    useAppStore.getState().upsertProject(project);
    toast.success(`Project “${project.name}” updated`);
  };

  const archiveProject = async (project: Project) => {
    if (project.id === useAppStore.getState().activeProjectId) await flushStoredProjectSession(project.id);
    const archived = await bridge.ArchiveProject(project.id);
    useAppStore.getState().upsertProject(archived);
    if (project.id === useAppStore.getState().activeProjectId) {
      const candidates = recentProjects(selectProjects(useAppStore.getState())).filter((candidate) => candidate.id !== project.id);
      if (candidates[0]) await switchProject(candidates[0].id);
      else { closeProjectDialogs(); useAppStore.getState().clearActiveProject(); }
    }
    toast.success(`Project “${project.name}” archived`);
  };

  const restoreProject = async (project: Project) => {
    const restored = await bridge.RestoreProject(project.id);
    useAppStore.getState().upsertProject(restored);
    toast.success(`Project “${restored.name}” restored`);
  };

  const workspaceHasItems = sources.length > 0 || connections.length > 0;

  const relationGridSource = (relation: ExternalRelationInfo, projectId: string): SourceInfo => ({
    projectId,
    id: relation.id,
    displayName: relation.name,
    tableName: relation.qualifiedName,
    kind: relation.relationType,
    rowCount: null,
    status: "ready",
    isEphemeral: false,
    columns: relation.columns,
  });

  /** Renders one workbench tab; every open tab keeps its own grid or editor. */
  const renderTabContent = (tab: AppTab): ReactNode => {
    if (!activeProjectId || !workspace) return null;
    const projectId = activeProjectId;

    if (tab.kind === "sql") {
      const document = workspace.session.documents.find((item) => item.id === tab.documentId);
      if (!document) return null;
      const outputKey = `${projectId}:${document.id}`;
      const resultSource = workspace.sourcesById[queryResultSourceIds[outputKey]];
      const editor = (
        <SQLEditorTab
          document={document}
          onChange={(value) => store.updateDocument(projectId, document.id, { sql: value })}
          onRun={(sql) => void runQuery({ documentId: document.id, sql })}
          onSave={() => { setSaveQueryDocumentId(document.id); setSaveQueryOpen(true); }}
          running={runningDocuments.has(document.id)}
          disabled={readySources.length === 0 && !connections.some((connection) => connection.status === "connected")}
          disabledReason={`Open a ready table or connect a database in ${activeProject?.name ?? workspace.project.name}`}
          sources={readySources}
          externalRelations={autocompleteRelations}
          history={workspace.session.history}
          error={queryErrors[document.id]}
        />
      );
      if (!resultSource) return editor;
      return (
        <PanelGroup direction="vertical">
          <Panel defaultSize={42} minSize={20}>{editor}</Panel>
          <PanelResizeHandle className="h-1 bg-border transition-colors hover:bg-primary/50 focus-visible:bg-primary" />
          <Panel defaultSize={58} minSize={20}>
            <section aria-label={`Output for ${document.title}`} className="flex h-full min-h-0 flex-col bg-background">
              <div className="ducs-glass-bar flex h-8 shrink-0 items-center gap-2 border-b border-border px-2 text-[10px] text-muted-foreground">
                <span className="font-semibold uppercase tracking-[0.12em]">Output</span>
                <Badge variant="muted">{resultSource.displayName}</Badge>
                <span>{resultSource.rowCount ?? 0} rows</span>
                <div className="ml-auto flex items-center gap-1">
                  {resultSource.isEphemeral
                    ? <Button variant="secondary" size="sm" onClick={() => { setSaveResultSourceId(resultSource.id); setSaveResultOpen(true); }}><Save /> Save as table</Button>
                    : <Badge variant="default">Saved table</Badge>}
                </div>
              </div>
              <div className="min-h-0 flex-1">
                <DataGrid
                  projectId={projectId}
                  source={resultSource}
                  onViewStateChange={(view) => setGridViews((current) => ({ ...current, [`${projectId}:source:${resultSource.id}`]: view }))}
                />
              </div>
            </section>
          </Panel>
        </PanelGroup>
      );
    }

    if (tab.relationId) {
      const relation = workspace.catalog.relationsById[tab.relationId];
      const connectionId = relation?.connectionId ?? tab.connectionId;
      const connection = connectionId ? store.connectionsById[connectionId] : undefined;
      if (!relation || connection?.status !== "connected") {
        return (
          <div className="grid h-full place-items-center text-center"><div><WifiOff className="mx-auto size-6 text-muted-foreground" /><p className="mt-3 text-[12px]">This live relation is disconnected</p><p className="mt-1 text-[10px] text-muted-foreground">Reconnect {connection?.name ?? "the database"} to hydrate this tab. If the relation no longer exists, the tab will close with a warning.</p>{connection && <Button variant="secondary" size="sm" className="mt-3" onClick={() => void connectDatabase(connection)}><RefreshCw /> Reconnect</Button>}</div></div>
        );
      }
      return (
        <div className="flex h-full min-h-0 flex-col">
          <div className="ducs-glass-bar flex h-9 shrink-0 items-center gap-2 border-b border-border bg-card px-2 text-[10px] text-muted-foreground">
            <DatabaseZap className="size-3.5 text-primary" /><code className="min-w-0 truncate text-foreground">{relation.qualifiedName}</code>
            <Button variant="ghost" size="icon-sm" aria-label="Copy qualified relation name" onClick={() => void navigator.clipboard?.writeText(relation.qualifiedName)}><Copy /></Button>
            <span className="truncate border-l border-border pl-2">{connection.name} · {connection.kind === "mongo" ? "MongoDB" : "PostgreSQL"}</span>
            <Badge variant="default">Live</Badge>{connection.kind === "mongo" && <Badge variant="warning">Experimental</Badge>}
            <div className="ml-auto flex items-center gap-1"><Button variant="secondary" size="sm" onClick={() => void snapshotRelation(relation)}><Save /> Snapshot locally</Button></div>
          </div>
          <div className="min-h-0 flex-1">
            <DataGrid
              projectId={projectId}
              source={relationGridSource(relation, projectId)}
              resource={{ kind: "external", relationId: relation.id }}
              pagingStable={relation.pagingStable}
              onReconnect={() => void reconnectDatabase(connection)}
              onViewStateChange={(view) => setGridViews((current) => ({ ...current, [`${projectId}:external:${relation.id}`]: view }))}
            />
          </div>
        </div>
      );
    }

    const source = tab.sourceId ? workspace.sourcesById[tab.sourceId] : undefined;
    if (!source) return null;
    const previewRows = previewRowsBySource[`${projectId}:${source.id}`];
    const view = previewRows ? { ...source, previewRows } : source;
    const job = jobs.find((item) => item.projectId === projectId && item.sourceId === source.id && (item.state === "queued" || item.state === "running"));
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="ducs-glass-bar flex h-8 shrink-0 items-center gap-2 border-b border-border bg-card px-2 text-[10px] text-muted-foreground">
          <span className="truncate">SQL name: <code className="text-foreground">{source.tableName}</code></span><Button variant="ghost" size="icon-sm" aria-label="Copy SQL table name" onClick={() => void navigator.clipboard?.writeText(source.tableName)}><Copy /></Button>
          {source.snapshot && <span className="truncate border-l border-border pl-2">Snapshot of <code className="text-foreground">{source.snapshot.catalog}.{source.snapshot.schema}.{source.snapshot.relation}</code> · {new Date(source.snapshot.refreshedAt).toLocaleString()}</span>}
          {source.originalSQL && (
            <>
              <span className="min-w-0 flex-1 truncate border-l border-border pl-2 font-mono" title={source.originalSQL}>{source.originalSQL.replace(/\s+/g, " ")}</span>
              <Button variant="ghost" size="icon-sm" className="size-6" aria-label="Copy source query" title="Copy source query" onClick={() => void copySourceQuery(source)}><Copy /></Button>
            </>
          )}
          <div className="ml-auto flex items-center gap-1">
            {source.snapshot && <Button variant="secondary" size="sm" disabled={!source.snapshot.connectionId} onClick={() => void refreshLocalSnapshot(source)}><RefreshCw /> Refresh snapshot</Button>}
            {source.isEphemeral && <Button variant="secondary" size="sm" onClick={() => { setSaveResultSourceId(source.id); setSaveResultOpen(true); }}><Save /> Save as table</Button>}
            <Button variant="ghost" size="sm" onClick={() => setPendingDelete({ kind: source.isEphemeral ? "result" : "dataset", projectId, id: source.id, name: source.displayName })}><Trash2 /> {source.isEphemeral ? "Discard" : "Remove"}</Button>
          </div>
        </div>
        <ImportStatusBanner source={view} job={job} onCancel={job ? () => void cancelJob(job) : undefined} onRetry={source.sourcePath ? () => setRetrySource(source) : undefined} />
        <div className="min-h-0 flex-1">
          <DataGrid
            projectId={projectId}
            source={view}
            onViewStateChange={(gridView) => setGridViews((current) => ({ ...current, [`${projectId}:source:${source.id}`]: gridView }))}
          />
        </div>
      </div>
    );
  };

  const workbench = !activeProjectId || !workspace ? null : !workspaceHasItems && workspace.session.tabs.length === 0 ? (
    <EmptyState projectName={activeProject?.name} onChoose={() => void openFiles()} onConnect={() => setAttachDialogOpen(true)} dragActive={dragActive} />
  ) : (
    <WorkbenchLayout
      layout={workspace.session.layout}
      onResize={(path, sizes) => store.setLayoutSizes(activeProjectId, path, sizes)}
      renderGroup={(groupId) => {
        const group = workspace.session.groups.find((item) => item.id === groupId);
        if (!group) return null;
        const groupTabList = group.tabIds.map((tabId) => tabsById[tabId]).filter(Boolean);
        const focusedTab = group.activeTabId ? tabsById[group.activeTabId] : undefined;
        return (
          <EditorGroup
            key={group.id}
            group={group}
            tabs={groupTabList}
            focused={workspace.session.activeGroupId === group.id}
            projectName={activeProject?.name ?? workspace.project.name}
            onFocus={() => store.setActiveGroup(activeProjectId, group.id)}
            onSelectTab={(tabId) => store.selectTab(activeProjectId, tabId)}
            onCloseTab={closeTab}
            onCloseOthers={(tabId) => store.closeOtherTabs(activeProjectId, group.id, tabId)}
            onNewQuery={() => store.openSQLTab(activeProjectId, { groupId: group.id })}
            onSplit={(direction, tabId) => store.splitGroup(activeProjectId, group.id, direction, tabId)}
            onDropTab={(tabId, index) => store.moveTab(activeProjectId, tabId, group.id, index)}
            onDropSplit={(tabId, direction) => {
              store.moveTab(activeProjectId, tabId, group.id);
              store.splitGroup(activeProjectId, group.id, direction, tabId);
            }}
            onOpenFiles={() => void openFiles()}
          >
            {focusedTab ? renderTabContent(focusedTab) : undefined}
          </EditorGroup>
        );
      }}
    />
  );

  if (!store.bootstrapped) return <div className="ducs-shell grid place-items-center"><div className="text-center"><span className="ducs-pulse mx-auto block size-2 rounded-full bg-primary" /><p className="mt-3 text-[11px] text-muted-foreground">Opening projects and local DuckDB workspaces…</p></div></div>;

  return (
    <TooltipProvider delayDuration={350}>
      <div className="ducs-shell flex flex-col text-foreground">
        <TopBar
          projects={projects}
          activeProjectId={activeProjectId}
          switchingProjectId={store.switchingProjectId}
          onSelectProject={(id) => void switchProject(id)}
          onNewProject={() => { setProjectManagerCreate(true); setProjectManagerOpen(true); }}
          onManageProjects={() => { setProjectManagerCreate(false); setProjectManagerOpen(true); }}
          onOpen={() => void openFiles()}
          onAddConnection={() => setAttachDialogOpen(true)}
          onExport={() => setExportOpen(true)}
          onToggleJobs={() => setJobsOpen(true)}
          onToggleAI={() => store.setPanel({ aiCollapsed: !store.panel.aiCollapsed })}
          aiOpen={!store.panel.aiCollapsed}
          activeJobs={activeJobs.length}
          canExport={Boolean(activeProjectId && ((activeSource?.status === "ready") || (activeRelation && activeConnection?.status === "connected")))}
        />
        {bootstrapError && <div role="alert" className="border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-[11px] text-destructive">{bootstrapError}</div>}
        {!activeProjectId || !workspace ? <main className="grid min-h-0 flex-1 place-items-center bg-background text-center"><div><FolderPlus className="mx-auto size-8 text-primary" /><h1 className="mt-4 text-lg font-semibold">Create your first project</h1><p className="mt-1 text-[12px] text-muted-foreground">Projects keep sources, SQL drafts, tabs, and history isolated.</p><Button className="mt-4" onClick={() => { setProjectManagerCreate(true); setProjectManagerOpen(true); }}><FolderPlus /> New project</Button></div></main> : <div className="min-h-0 flex-1">
          <PanelGroup direction="horizontal" onLayout={(sizes) => sizes[1] && store.setPanel({ aiSize: sizes[1] })}>
            <Panel minSize={50}>
          <div className="flex h-full min-w-0">
          {store.panel.sidebarCollapsed && (
            <SidebarRail
              onExpand={toggleSidebar}
              onNewQuery={() => store.openSQLTab(activeProjectId)}
              onOpenFiles={() => void openFiles()}
              onAddConnection={() => setAttachDialogOpen(true)}
            />
          )}
          <PanelGroup className="min-w-0 flex-1" direction="horizontal" onLayout={(sizes) => sizes[0] > 0 && store.setPanel({ sidebarSize: sizes[0] })}>
            <Panel
              ref={sidebarPanelRef}
              defaultSize={store.panel.sidebarCollapsed ? 0 : store.panel.sidebarSize}
              minSize={15}
              maxSize={32}
              collapsible
              collapsedSize={0}
              onCollapse={() => store.setPanel({ sidebarCollapsed: true })}
              onExpand={() => store.setPanel({ sidebarCollapsed: false })}
            >
              <Sidebar
                projectName={activeProject?.name ?? workspace.project.name}
                sources={sources}
                savedQueries={savedQueries}
                activeSourceId={activeSourceId}
                onSelectSource={(id) => store.selectSource(activeProjectId, id)}
                onInsertTable={(source) => store.insertIntoDraft(activeProjectId, quoteIdentifier(source.tableName))}
                onCopyTable={(source) => void navigator.clipboard?.writeText(quoteIdentifier(source.tableName))}
                onRenameSource={renameSource}
                onQuickRemoveSource={quickRemoveSource}
                onSelectSavedQuery={(query) => store.loadSavedQuery(activeProjectId, query.id)}
                onRenameSavedQuery={renameSavedQuery}
                onDeleteSavedQuery={(query) => setPendingDelete({ kind: "query", projectId: activeProjectId, id: query.id, name: query.name })}
                onRemoveSource={(source) => setPendingDelete({ kind: "dataset", projectId: activeProjectId, id: source.id, name: source.displayName })}
                onRefreshSnapshot={(source) => void refreshLocalSnapshot(source)}
                connectionTree={{
                  projectName: activeProject?.name ?? workspace.project.name,
                  connections,
                  schemasByConnection: workspace.catalog.schemasByConnection,
                  relationsBySchema: workspace.catalog.relationsBySchema,
                  loading: new Set([...catalogLoading].filter((key) => key.startsWith(`${activeProjectId}:`)).map((key) => key.slice(activeProjectId.length + 1))),
                  errors: Object.fromEntries(Object.entries(catalogErrors).filter(([key]) => key.startsWith(`${activeProjectId}:`)).map(([key, value]) => [key.slice(activeProjectId.length + 1), value])),
                  activeRelationId: activeRelation?.id,
                  onExpandConnection: (connection) => void loadSchemas(connection),
                  onExpandSchema: (connection, schema) => void loadRelations(connection, schema),
                  onOpenRelation: (relation) => void openExternalRelation(relation),
                  onInsertRelation: (relation) => store.insertIntoDraft(activeProjectId, relation.qualifiedName),
                  onCopyRelation: (relation) => void navigator.clipboard?.writeText(relation.qualifiedName),
                  onSnapshotRelation: (relation) => void snapshotRelation(relation),
                  onConnect: (connection) => void connectDatabase(connection),
                  onDisconnect: (connection) => void disconnectDatabase(connection),
                  onEdit: (connection) => { setEditingConnection(connection); setConnectionDialogOpen(true); },
                  onRefresh: (connection) => void refreshCatalog(connection),
                  onRemove: (connection) => setPendingDetach({ projectId: activeProjectId, connection }),
                }}
              />
            </Panel>
            <PanelResizeHandle
              className={store.panel.sidebarCollapsed ? "relative z-20 w-0 overflow-visible" : "relative z-20 w-1 overflow-visible bg-border transition-colors hover:bg-primary/50 focus-visible:bg-primary"}
              data-sidebar-resize-handle
            >
              {!store.panel.sidebarCollapsed && <SidebarToggle open onToggle={toggleSidebar} />}
            </PanelResizeHandle>
            <Panel minSize={65}>
              <main className="flex h-full min-h-0 flex-col bg-background">
                <div className="min-h-0 flex-1">{workbench}</div>
              </main>
            </Panel>
          </PanelGroup>
          </div>
            </Panel>
            {!store.panel.aiCollapsed && <>
              <PanelResizeHandle className="w-1 bg-border transition-colors hover:bg-primary/50 focus-visible:bg-primary" />
              <Panel defaultSize={store.panel.aiSize} minSize={20} maxSize={45}>
                <AIChatPanel
                  projectId={activeProjectId}
                  projectName={activeProject?.name ?? workspace.project.name}
                  sourceName={activeSource?.displayName ?? activeRelation?.qualifiedName}
                  onClose={() => store.setPanel({ aiCollapsed: true })}
                  onReplaceSQL={(sql) => store.setDraft(activeProjectId, sql)}
                  onAppendSQL={(sql) => store.insertIntoDraft(activeProjectId, sql)}
                  onExecuteSQL={(sql) => { store.setDraft(activeProjectId, sql); void runQuery({ sql }); }}
                />
              </Panel>
            </>}
          </PanelGroup>
        </div>}
        <StatusBar source={activeSource} jobs={jobs} />
      </div>

      <JobsPanel open={jobsOpen} onOpenChange={setJobsOpen} jobs={jobs} projects={projects} activeProjectId={activeProjectId} onCancel={(job) => void cancelJob(job)} />
      {activeWorkbook && <SheetPicker workbook={activeWorkbook} open onOpenChange={(open) => { if (!open) flushForDialog(() => setWorkbooks((items) => items.filter((item) => item !== activeWorkbook))); }} onConfirm={(sheet) => void chooseSheet(sheet)} busy={sheetBusy} />}
      <RetryImportDialog open={Boolean(retrySource)} onOpenChange={(open) => { if (!open) flushForDialog(() => setRetrySource(undefined)); }} kind={retrySource?.kind} onConfirm={(options) => void retryImport(options)} busy={retryBusy} />
      <NameDialog open={saveQueryOpen} onOpenChange={(open) => open ? setSaveQueryOpen(true) : flushForDialog(() => { setSaveQueryOpen(false); setSaveQueryDocumentId(undefined); })} title="Save query" description={`Saved SQL belongs only to ${activeProject?.name ?? "this project"}.`} initialName={saveQuerySavedName ?? saveQueryDocument?.title ?? ""} actionLabel="Save query" busy={saveQueryBusy} onSubmit={(name) => void saveQuery(name)} />
      <NameDialog open={saveResultOpen} onOpenChange={(open) => open ? setSaveResultOpen(true) : flushForDialog(() => { setSaveResultOpen(false); setSaveResultSourceId(undefined); })} title="Save result as table" description={`Create a persistent DuckDB table in ${activeProject?.name ?? "this project"}.`} initialName="" actionLabel="Save table" busy={saveResultBusy} onSubmit={(name) => void saveResult(name)} />
      <ExportDialog open={exportOpen} onOpenChange={(open) => open ? setExportOpen(true) : flushForDialog(() => setExportOpen(false))} busy={exportBusy} onExport={(scope) => void exportCSV(scope)} />
      {activeProject && <ConnectionAttachDialog open={attachDialogOpen} projectName={activeProject.name} availableConnections={unattachedConnections} attachingId={attachingConnectionId} onOpenChange={(open) => open ? setAttachDialogOpen(true) : flushForDialog(() => setAttachDialogOpen(false))} onAttach={(connection) => void attachConnection(connection)} onNew={() => { setAttachDialogOpen(false); setEditingConnection(undefined); setConnectionDialogOpen(true); }} onManage={() => { setAttachDialogOpen(false); setConnectionManagerOpen(true); }} />}
      <ConnectionDialog open={connectionDialogOpen} onOpenChange={(open) => { if (open) setConnectionDialogOpen(true); else flushForDialog(() => { setConnectionDialogOpen(false); setEditingConnection(undefined); }); }} projectId={!editingConnection || workspace?.connectionIds.includes(editingConnection.id) ? activeProjectId : undefined} connection={editingConnection} onSaved={(connection) => { store.upsertConnection(connection); if (activeProjectId && !editingConnection) store.attachConnection(activeProjectId, connection.id); setEditingConnection(connection); }} />
      <ConnectionManagerDialog open={connectionManagerOpen} connections={globalConnections} onOpenChange={(open) => open ? setConnectionManagerOpen(true) : flushForDialog(() => setConnectionManagerOpen(false))} onEdit={(connection) => { setConnectionManagerOpen(false); setEditingConnection(connection); setConnectionDialogOpen(true); }} onUsageCount={connectionUsage} onDelete={deleteGlobalConnection} />
      <ProjectManagerDialog open={projectManagerOpen} createOnOpen={projectManagerCreate} projects={projects} activeProjectId={activeProjectId} onOpenChange={(open) => { if (open) setProjectManagerOpen(true); else flushForDialog(() => { setProjectManagerOpen(false); setProjectManagerCreate(false); }); }} onCreate={createProject} onUpdate={updateProject} onArchive={archiveProject} onRestore={restoreProject} />
      <ConfirmDialog open={Boolean(pendingDelete)} onOpenChange={(open) => { if (!open) flushForDialog(() => setPendingDelete(undefined)); }} title={pendingDelete?.kind === "result" ? "Discard this result?" : pendingDelete?.kind === "query" ? "Delete saved query?" : "Remove this dataset?"} description={pendingDelete?.kind === "result" ? `“${pendingDelete.name}” is ephemeral and will be dropped from this project.` : pendingDelete?.kind === "query" ? `“${pendingDelete.name}” will be removed from this project's saved SQL.` : `“${pendingDelete?.name ?? "This dataset"}” will be removed from ${pendingDelete ? projectName(pendingDelete.projectId) : "the project"}. The original file remains untouched.`} actionLabel={pendingDelete?.kind === "result" ? "Discard" : "Remove"} onConfirm={() => void confirmDelete()} />
      <ConfirmDialog open={Boolean(pendingDetach)} onOpenChange={(open) => { if (!open) flushForDialog(() => setPendingDetach(undefined)); }} title="Remove connection from this project?" description={`“${pendingDetach?.connection.name ?? "This connection"}” remains available globally and can be attached again. Other projects are not affected.`} actionLabel="Remove from project" onConfirm={() => void detachConnection()} />
      <Toaster theme="dark" position="bottom-right" richColors closeButton toastOptions={{ style: { background: "rgba(19, 19, 23, .94)", border: "1px solid rgba(255, 255, 255, .1)", color: "#f4f4f5", backdropFilter: "blur(24px)" } }} />
      {dragActive && workspaceHasItems && <div className="pointer-events-none fixed inset-3 z-40 grid place-items-center rounded-xl border-2 border-dashed border-primary bg-background/80 text-primary backdrop-blur-sm"><div className="text-center"><p className="text-lg font-semibold">Drop to import into {activeProject?.name}</p><p className="mt-1 text-[11px] text-muted-foreground">Files are processed locally</p></div></div>}
    </TooltipProvider>
  );
}
