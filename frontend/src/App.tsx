import { useCallback, useEffect, useMemo, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { ChevronUp, Code2, Copy, DatabaseZap, FolderPlus, RefreshCw, Save, Trash2, WifiOff } from "lucide-react";
import { Toaster, toast } from "sonner";
import { bridge, getErrorMessage, normalizeSource } from "@/lib/bridge";
import { flushAllProjectSessions, flushProjectSession, markProjectSessionSaved, scheduleProjectSessionSave } from "@/lib/project-session-sync";
import { quoteIdentifier } from "@/lib/utils";
import type {
  ConnectionInfo,
  DataRow,
  ExternalRelationInfo,
  GridResourceRef,
  ImportOptions,
  ImportPathsResult,
  ImportStartResult,
  Job,
  Project,
  SourceInfo,
  WorkbookSheets,
} from "@/types";
import { recentProjects } from "@/lib/projects";
import {
  selectActiveRelation,
  selectActiveSource,
  selectActiveWorkspace,
  preserveWorkspaceMutations,
  selectProjects,
  selectWorkspaceQueries,
  selectWorkspaceSources,
  useAppStore,
} from "@/stores/app-store";
import DataGrid, { type GridViewState } from "@/components/data-grid/DataGrid";
import SQLPanel from "@/components/sql-editor/SQLPanel";
import { TopBar } from "@/components/layout/TopBar";
import { Sidebar } from "@/components/layout/Sidebar";
import { TabsBar } from "@/components/layout/TabsBar";
import { StatusBar } from "@/components/layout/StatusBar";
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
  const activeTab = workspace?.session.tabs.find((tab) => tab.id === workspace.session.activeTabId);
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
  const [queryRunningProjects, setQueryRunningProjects] = useState<Set<string>>(new Set());
  const [queryErrors, setQueryErrors] = useState<Record<string, string | undefined>>({});
  const [saveQueryOpen, setSaveQueryOpen] = useState(false);
  const [saveQueryBusy, setSaveQueryBusy] = useState(false);
  const [saveResultOpen, setSaveResultOpen] = useState(false);
  const [saveResultBusy, setSaveResultBusy] = useState(false);
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

  const sqlText = workspace?.session.sqlDraft ?? "";
  const activePreviewKey = activeProjectId && activeSource ? `${activeProjectId}:${activeSource.id}` : undefined;
  const activeSourceView = activeSource && activePreviewKey && previewRowsBySource[activePreviewKey]
    ? { ...activeSource, previewRows: previewRowsBySource[activePreviewKey] }
    : activeSource;
  const readySources = useMemo(() => sources.filter((source) => source.status === "ready"), [sources]);
  const autocompleteRelations = useMemo(() => workspace ? Object.values(workspace.catalog.relationsById).filter((relation) => relation.columns.length > 0 && store.connectionsById[relation.connectionId]?.status === "connected") : [], [store.connectionsById, workspace]);
  const activeJobs = useMemo(() => jobs.filter((job) => job.state === "queued" || job.state === "running"), [jobs]);
  const activeGridId = activeSource?.id ?? activeRelation?.id;
  const activeResource: GridResourceRef | undefined = activeSource ? { kind: "source", sourceId: activeSource.id } : activeRelation ? { kind: "external", relationId: activeRelation.id } : undefined;
  const activeJob = activeGridId && activeProjectId ? jobs.find((job) => job.projectId === activeProjectId && job.sourceId === activeGridId && (job.state === "queued" || job.state === "running")) : undefined;
  const activeSavedQueryId = activeProjectId ? store.activeSavedQueryIds[activeProjectId] : undefined;
  const activeSavedQuery = activeSavedQueryId ? workspace?.savedQueriesById[activeSavedQueryId] : undefined;
  const activeWorkbook = activeProjectId ? workbooks.find((workbook) => workbook.projectId === activeProjectId) : undefined;
  const unattachedConnections = useMemo(() => globalConnections.filter((connection) => !workspace?.connectionIds.includes(connection.id)), [globalConnections, workspace]);
  const displayTabs = useMemo(() => (workspace?.session.tabs ?? []).map((tab) => {
    if (!tab.relationId) return tab;
    const relation = workspace?.catalog.relationsById[tab.relationId];
    const connectionId = relation?.connectionId ?? tab.connectionId;
    if (!connectionId || store.connectionsById[connectionId]?.status !== "connected") return { ...tab, kind: "placeholder" as const, placeholderReason: "disconnected" as const };
    return tab;
  }), [store.connectionsById, workspace]);

  const closeProjectDialogs = useCallback(() => {
    setWorkbooks([]);
    setRetrySource(undefined);
    setSaveQueryOpen(false);
    setSaveResultOpen(false);
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

  const handleBatch = useCallback((projectId: string, batch: ImportPathsResult | ImportStartResult) => {
    const actions = useAppStore.getState();
    for (const rawSource of batch.sources ?? []) {
      if (Array.isArray(rawSource.previewRows)) setPreviewRowsBySource((current) => ({ ...current, [`${projectId}:${rawSource.id}`]: rawSource.previewRows! }));
      const source = normalizeSource(rawSource, projectId);
      actions.upsertSource(projectId, source);
      if (actions.activeProjectId === projectId) actions.openTab(projectId, source.id);
      if (source.status === "failed") toast.error(projectToast(projectId, source.error?.message ?? `Could not import ${source.displayName}`));
    }
    for (const job of batch.jobs ?? []) actions.upsertJob(projectId, job);
    if ("workbooks" in batch && batch.workbooks?.length && actions.activeProjectId === projectId) {
      setWorkbooks((current) => [...current, ...batch.workbooks!.map((workbook) => ({ ...workbook, projectId }))]);
    }
  }, []);

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
          if (source) actions.upsertSource(job.projectId, { ...source, status: "cancelled" });
        }
        if (job.state === "failed") toast.error(projectToast(job.projectId, job.error?.message ?? `${job.kind} failed`));
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
        if (!cancelled) toast.error(projectToast(payload.projectId, payload.error.message));
      }),
      bridge.on("ducs:result-ready", ({ projectId, source: raw }) => {
        if (!projectId) return;
        const actions = useAppStore.getState();
        const normalized = normalizeSource(raw, projectId);
        const existing = actions.projectWorkspaces[projectId]?.sourcesById[normalized.id];
        const source = { ...normalized, displayName: existing?.displayName ?? normalized.displayName, status: "ready" as const };
        actions.upsertSource(projectId, source);
        if (actions.activeProjectId === projectId) actions.openTab(projectId, source.id);
      }),
      bridge.on("ducs:file-drop", (payload) => {
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
  }, [importPaths]);

  useEffect(() => {
    const enter = (event: DragEvent) => { event.preventDefault(); setDragActive(true); };
    const over = (event: DragEvent) => event.preventDefault();
    const leave = (event: DragEvent) => { if (!event.relatedTarget) setDragActive(false); };
    const drop = (event: DragEvent) => { event.preventDefault(); setDragActive(false); };
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

  const runQuery = async () => {
    const state = useAppStore.getState();
    const projectId = state.activeProjectId;
    const sql = projectId ? state.projectWorkspaces[projectId]?.session.sqlDraft : undefined;
    if (!projectId || !sql?.trim() || queryRunningProjects.has(projectId)) return;
    setQueryRunningProjects((current) => new Set(current).add(projectId));
    setQueryErrors((current) => ({ ...current, [projectId]: undefined }));
    const started = performance.now();
    try {
      const result = await bridge.RunQuery({ projectId, sql });
      const source = { ...normalizeSource(result.source, projectId), displayName: useAppStore.getState().nextResultName(projectId), status: "ready" as const };
      const actions = useAppStore.getState();
      actions.upsertSource(projectId, source);
      if (actions.activeProjectId === projectId) actions.openTab(projectId, source.id);
      actions.addHistory(projectId, { sql, status: "success", durationMs: result.durationMs ?? Math.round(performance.now() - started) });
      toast.success(projectToast(projectId, `${source.displayName} created`), { description: `${result.rowCount ?? source.rowCount ?? 0} rows in ${result.durationMs ?? Math.round(performance.now() - started)}ms` });
    } catch (error) {
      const message = getErrorMessage(error);
      if (useAppStore.getState().activeProjectId === projectId) setQueryErrors((current) => ({ ...current, [projectId]: message }));
      useAppStore.getState().addHistory(projectId, { sql, status: "error", durationMs: Math.round(performance.now() - started) });
      toast.error(projectToast(projectId, "Query failed"), { description: message });
    } finally {
      setQueryRunningProjects((current) => {
        const next = new Set(current);
        next.delete(projectId);
        return next;
      });
    }
  };

  const saveQuery = async (name: string) => {
    const state = useAppStore.getState();
    const projectId = state.activeProjectId;
    const sql = projectId ? state.projectWorkspaces[projectId]?.session.sqlDraft : undefined;
    if (!projectId || sql === undefined) return;
    setSaveQueryBusy(true);
    try {
      const queryId = state.activeSavedQueryIds[projectId];
      const saved = await bridge.SaveQuery({ projectId, id: queryId, name, sql });
      useAppStore.getState().upsertSavedQuery(projectId, saved);
      await flushStoredProjectSession(projectId);
      setSaveQueryOpen(false);
      toast.success(projectToast(projectId, `Saved query “${saved.name}”`));
    } catch (error) { toast.error(projectToast(projectId, getErrorMessage(error))); }
    finally { setSaveQueryBusy(false); }
  };

  const saveResult = async (name: string) => {
    const projectId = useAppStore.getState().activeProjectId;
    const source = projectId ? selectActiveSource(useAppStore.getState()) : undefined;
    if (!projectId || !source?.isEphemeral) return;
    setSaveResultBusy(true);
    try {
      const saved = normalizeSource(await bridge.SaveResultAsTable({ projectId, resultId: source.id, displayName: name }), projectId);
      useAppStore.getState().upsertSource(projectId, { ...saved, status: "ready" });
      await flushStoredProjectSession(projectId);
      setSaveResultOpen(false);
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
      useAppStore.getState().upsertJob(projectId, await bridge.CancelJob(job.id));
      const source = job.kind === "import" && job.sourceId ? useAppStore.getState().projectWorkspaces[projectId]?.sourcesById[job.sourceId] : undefined;
      if (source) useAppStore.getState().upsertSource(projectId, { ...source, status: "cancelled" });
    } catch (error) { toast.error(projectToast(projectId, getErrorMessage(error))); }
  };

  const closeTab = (tabId: string) => {
    const projectId = useAppStore.getState().activeProjectId;
    const currentWorkspace = projectId ? useAppStore.getState().projectWorkspaces[projectId] : undefined;
    const tab = currentWorkspace?.session.tabs.find((item) => item.id === tabId);
    const source = tab?.sourceId ? currentWorkspace?.sourcesById[tab.sourceId] : undefined;
    if (!projectId) return;
    if (source?.isEphemeral) setPendingDelete({ kind: "result", projectId, id: source.id, name: source.displayName });
    else useAppStore.getState().closeTab(projectId, tabId);
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

  const externalGridSource: SourceInfo | undefined = activeProjectId && activeRelation ? {
    projectId: activeProjectId,
    id: activeRelation.id,
    displayName: activeRelation.name,
    tableName: activeRelation.qualifiedName,
    kind: activeRelation.relationType,
    rowCount: null,
    status: "ready",
    isEphemeral: false,
    columns: activeRelation.columns,
  } : undefined;
  const workspaceHasItems = sources.length > 0 || connections.length > 0;

  const placeholder = activeTab?.relationId && (!activeRelation || activeConnection?.status !== "connected");
  const content = placeholder ? (
    <div className="grid h-full place-items-center text-center"><div><WifiOff className="mx-auto size-6 text-muted-foreground" /><p className="mt-3 text-[12px]">This live relation is disconnected</p><p className="mt-1 text-[10px] text-muted-foreground">Reconnect {activeConnection?.name ?? "the database"} to hydrate this tab. If the relation no longer exists, the tab will close with a warning.</p>{activeConnection && <Button variant="secondary" size="sm" className="mt-3" onClick={() => void connectDatabase(activeConnection)}><RefreshCw /> Reconnect</Button>}</div></div>
  ) : activeRelation && externalGridSource && activeProjectId ? (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-card px-2 text-[10px] text-muted-foreground">
        <DatabaseZap className="size-3.5 text-primary" /><code className="min-w-0 truncate text-foreground">{activeRelation.qualifiedName}</code>
        <Button variant="ghost" size="icon-sm" aria-label="Copy qualified relation name" onClick={() => void navigator.clipboard?.writeText(activeRelation.qualifiedName)}><Copy /></Button>
        <span className="truncate border-l border-border pl-2">{activeConnection?.name ?? "External database"} · {activeConnection?.kind === "mongo" ? "MongoDB" : "PostgreSQL"}</span>
        <Badge variant="default">Live</Badge>{activeConnection?.kind === "mongo" && <Badge variant="warning">Experimental</Badge>}
        <div className="ml-auto flex items-center gap-1"><Button variant="secondary" size="sm" onClick={() => void snapshotRelation(activeRelation)}><Save /> Snapshot locally</Button><Button variant="ghost" size="sm" onClick={() => store.setPanel({ sqlCollapsed: !store.panel.sqlCollapsed })}><Code2 /> {store.panel.sqlCollapsed ? "Show SQL" : "Hide SQL"}</Button></div>
      </div>
      <div className="min-h-0 flex-1"><DataGrid projectId={activeProjectId} source={externalGridSource} resource={{ kind: "external", relationId: activeRelation.id }} pagingStable={activeRelation.pagingStable} onReconnect={() => activeConnection && void reconnectDatabase(activeConnection)} onViewStateChange={(view) => setGridViews((current) => ({ ...current, [`${activeProjectId}:external:${activeRelation.id}`]: view }))} /></div>
    </div>
  ) : activeSource && activeProjectId ? (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border bg-card px-2 text-[10px] text-muted-foreground">
        <span className="truncate">SQL name: <code className="text-foreground">{activeSource.tableName}</code></span><Button variant="ghost" size="icon-sm" aria-label="Copy SQL table name" onClick={() => void navigator.clipboard?.writeText(activeSource.tableName)}><Copy /></Button>
        {activeSource.snapshot && <span className="truncate border-l border-border pl-2">Snapshot of <code className="text-foreground">{activeSource.snapshot.catalog}.{activeSource.snapshot.schema}.{activeSource.snapshot.relation}</code> · {new Date(activeSource.snapshot.refreshedAt).toLocaleString()}</span>}
        {activeSource.originalSQL && <span className="min-w-0 flex-1 truncate border-l border-border pl-2 font-mono">{activeSource.originalSQL.replace(/\s+/g, " ")}</span>}
        <div className="ml-auto flex items-center gap-1">
          {activeSource.snapshot && <Button variant="secondary" size="sm" disabled={!activeSource.snapshot.connectionId} onClick={() => void refreshLocalSnapshot(activeSource)}><RefreshCw /> Refresh snapshot</Button>}
          {activeSource.isEphemeral && <Button variant="secondary" size="sm" onClick={() => setSaveResultOpen(true)}><Save /> Save as table</Button>}
          <Button variant="ghost" size="sm" onClick={() => setPendingDelete({ kind: activeSource.isEphemeral ? "result" : "dataset", projectId: activeProjectId, id: activeSource.id, name: activeSource.displayName })}><Trash2 /> {activeSource.isEphemeral ? "Discard" : "Remove"}</Button>
          <Button variant="ghost" size="sm" onClick={() => store.setPanel({ sqlCollapsed: !store.panel.sqlCollapsed })}><Code2 /> {store.panel.sqlCollapsed ? "Show SQL" : "Hide SQL"}</Button>
        </div>
      </div>
      <ImportStatusBanner source={activeSourceView!} job={activeJob} onCancel={activeJob ? () => void cancelJob(activeJob) : undefined} onRetry={activeSource.sourcePath ? () => setRetrySource(activeSource) : undefined} />
      <div className="min-h-0 flex-1"><DataGrid projectId={activeProjectId} source={activeSourceView!} onViewStateChange={(view) => setGridViews((current) => ({ ...current, [`${activeProjectId}:source:${activeSource.id}`]: view }))} /></div>
    </div>
  ) : workspaceHasItems ? (
    <div className="grid h-full place-items-center bg-background text-center"><div><p className="text-[13px] text-foreground">Choose a table or live relation in {activeProject?.name}</p><p className="mt-1 text-[11px] text-muted-foreground">Files, snapshots, query results, and external relations open as separate tabs.</p></div></div>
  ) : (
    <EmptyState projectName={activeProject?.name} onChoose={() => void openFiles()} onConnect={() => setAttachDialogOpen(true)} dragActive={dragActive} />
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
          activeJobs={activeJobs.length}
          canExport={Boolean(activeProjectId && ((activeSource?.status === "ready") || (activeRelation && activeConnection?.status === "connected")))}
        />
        {bootstrapError && <div role="alert" className="border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-[11px] text-destructive">{bootstrapError}</div>}
        {!activeProjectId || !workspace ? <main className="grid min-h-0 flex-1 place-items-center bg-background text-center"><div><FolderPlus className="mx-auto size-8 text-primary" /><h1 className="mt-4 text-lg font-semibold">Create your first project</h1><p className="mt-1 text-[12px] text-muted-foreground">Projects keep sources, SQL drafts, tabs, and history isolated.</p><Button className="mt-4" onClick={() => { setProjectManagerCreate(true); setProjectManagerOpen(true); }}><FolderPlus /> New project</Button></div></main> : <div className="min-h-0 flex-1">
          <PanelGroup direction="horizontal" onLayout={(sizes) => store.setPanel({ sidebarSize: sizes[0] })}>
            <Panel defaultSize={store.panel.sidebarSize} minSize={15} maxSize={32}>
              <Sidebar
                projectName={activeProject?.name ?? workspace.project.name}
                sources={sources}
                savedQueries={savedQueries}
                activeSourceId={activeSourceId}
                onSelectSource={(id) => store.selectSource(activeProjectId, id)}
                onInsertTable={(source) => store.insertIntoDraft(activeProjectId, quoteIdentifier(source.tableName))}
                onCopyTable={(source) => void navigator.clipboard?.writeText(quoteIdentifier(source.tableName))}
                onSelectSavedQuery={(query) => store.loadSavedQuery(activeProjectId, query.id)}
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
            <PanelResizeHandle className="w-1 bg-border transition-colors hover:bg-primary/50 focus-visible:bg-primary" />
            <Panel minSize={65}>
              <main className="flex h-full min-h-0 flex-col bg-background">
                <TabsBar tabs={displayTabs} activeTabId={workspace.session.activeTabId} onSelect={(id) => store.selectTab(activeProjectId, id)} onClose={closeTab} />
                {!workspaceHasItems ? content : store.panel.sqlCollapsed ? <><div className="min-h-0 flex-1">{content}</div><button className="flex h-8 shrink-0 items-center justify-center gap-1.5 border-t border-border bg-card text-[10px] text-muted-foreground hover:text-primary" onClick={() => store.setPanel({ sqlCollapsed: false })}><ChevronUp className="size-3" /> Open SQL editor</button></> : (
                  <PanelGroup direction="vertical" onLayout={(sizes) => sizes[1] && store.setPanel({ sqlSize: sizes[1] })}>
                    <Panel defaultSize={100 - store.panel.sqlSize} minSize={35}>{content}</Panel>
                    <PanelResizeHandle className="h-1 bg-border transition-colors hover:bg-primary/50 focus-visible:bg-primary" />
                    <Panel defaultSize={store.panel.sqlSize} minSize={18} maxSize={55} collapsible collapsedSize={0} onCollapse={() => store.setPanel({ sqlCollapsed: true })}>
                      <SQLPanel value={sqlText} onChange={(value) => store.setDraft(activeProjectId, value)} onRun={() => void runQuery()} onNew={() => { store.newDraft(activeProjectId); setQueryErrors((current) => ({ ...current, [activeProjectId]: undefined })); }} onSave={() => setSaveQueryOpen(true)} running={queryRunningProjects.has(activeProjectId)} disabled={readySources.length === 0 && !connections.some((connection) => connection.status === "connected")} disabledReason={`Open a ready table or connect a database in ${activeProject?.name ?? workspace.project.name}`} sources={readySources} externalRelations={autocompleteRelations} history={workspace.session.history} error={queryErrors[activeProjectId]} />
                    </Panel>
                  </PanelGroup>
                )}
              </main>
            </Panel>
          </PanelGroup>
        </div>}
        <StatusBar source={activeSource} jobs={jobs} />
      </div>

      <JobsPanel open={jobsOpen} onOpenChange={setJobsOpen} jobs={jobs} projects={projects} activeProjectId={activeProjectId} onCancel={(job) => void cancelJob(job)} />
      {activeWorkbook && <SheetPicker workbook={activeWorkbook} open onOpenChange={(open) => { if (!open) flushForDialog(() => setWorkbooks((items) => items.filter((item) => item !== activeWorkbook))); }} onConfirm={(sheet) => void chooseSheet(sheet)} busy={sheetBusy} />}
      <RetryImportDialog open={Boolean(retrySource)} onOpenChange={(open) => { if (!open) flushForDialog(() => setRetrySource(undefined)); }} kind={retrySource?.kind} onConfirm={(options) => void retryImport(options)} busy={retryBusy} />
      <NameDialog open={saveQueryOpen} onOpenChange={(open) => open ? setSaveQueryOpen(true) : flushForDialog(() => setSaveQueryOpen(false))} title="Save query" description={`Saved SQL belongs only to ${activeProject?.name ?? "this project"}.`} initialName={activeSavedQuery?.name ?? ""} actionLabel="Save query" busy={saveQueryBusy} onSubmit={(name) => void saveQuery(name)} />
      <NameDialog open={saveResultOpen} onOpenChange={(open) => open ? setSaveResultOpen(true) : flushForDialog(() => setSaveResultOpen(false))} title="Save result as table" description={`Create a persistent DuckDB table in ${activeProject?.name ?? "this project"}.`} initialName="" actionLabel="Save table" busy={saveResultBusy} onSubmit={(name) => void saveResult(name)} />
      <ExportDialog open={exportOpen} onOpenChange={(open) => open ? setExportOpen(true) : flushForDialog(() => setExportOpen(false))} busy={exportBusy} onExport={(scope) => void exportCSV(scope)} />
      {activeProject && <ConnectionAttachDialog open={attachDialogOpen} projectName={activeProject.name} availableConnections={unattachedConnections} attachingId={attachingConnectionId} onOpenChange={(open) => open ? setAttachDialogOpen(true) : flushForDialog(() => setAttachDialogOpen(false))} onAttach={(connection) => void attachConnection(connection)} onNew={() => { setAttachDialogOpen(false); setEditingConnection(undefined); setConnectionDialogOpen(true); }} onManage={() => { setAttachDialogOpen(false); setConnectionManagerOpen(true); }} />}
      <ConnectionDialog open={connectionDialogOpen} onOpenChange={(open) => { if (open) setConnectionDialogOpen(true); else flushForDialog(() => { setConnectionDialogOpen(false); setEditingConnection(undefined); }); }} projectId={!editingConnection || workspace?.connectionIds.includes(editingConnection.id) ? activeProjectId : undefined} connection={editingConnection} onSaved={(connection) => { store.upsertConnection(connection); if (activeProjectId && !editingConnection) store.attachConnection(activeProjectId, connection.id); setEditingConnection(connection); }} />
      <ConnectionManagerDialog open={connectionManagerOpen} connections={globalConnections} onOpenChange={(open) => open ? setConnectionManagerOpen(true) : flushForDialog(() => setConnectionManagerOpen(false))} onEdit={(connection) => { setConnectionManagerOpen(false); setEditingConnection(connection); setConnectionDialogOpen(true); }} onUsageCount={connectionUsage} onDelete={deleteGlobalConnection} />
      <ProjectManagerDialog open={projectManagerOpen} createOnOpen={projectManagerCreate} projects={projects} activeProjectId={activeProjectId} onOpenChange={(open) => { if (open) setProjectManagerOpen(true); else flushForDialog(() => { setProjectManagerOpen(false); setProjectManagerCreate(false); }); }} onCreate={createProject} onUpdate={updateProject} onArchive={archiveProject} onRestore={restoreProject} />
      <ConfirmDialog open={Boolean(pendingDelete)} onOpenChange={(open) => { if (!open) flushForDialog(() => setPendingDelete(undefined)); }} title={pendingDelete?.kind === "result" ? "Discard this result?" : pendingDelete?.kind === "query" ? "Delete saved query?" : "Remove this dataset?"} description={pendingDelete?.kind === "result" ? `“${pendingDelete.name}” is ephemeral and will be dropped from this project.` : pendingDelete?.kind === "query" ? `“${pendingDelete.name}” will be removed from this project's saved SQL.` : `“${pendingDelete?.name ?? "This dataset"}” will be removed from ${pendingDelete ? projectName(pendingDelete.projectId) : "the project"}. The original file remains untouched.`} actionLabel={pendingDelete?.kind === "result" ? "Discard" : "Remove"} onConfirm={() => void confirmDelete()} />
      <ConfirmDialog open={Boolean(pendingDetach)} onOpenChange={(open) => { if (!open) flushForDialog(() => setPendingDetach(undefined)); }} title="Remove connection from this project?" description={`“${pendingDetach?.connection.name ?? "This connection"}” remains available globally and can be attached again. Other projects are not affected.`} actionLabel="Remove from project" onConfirm={() => void detachConnection()} />
      <Toaster theme="dark" position="bottom-right" richColors closeButton toastOptions={{ style: { background: "#0d120f", border: "1px solid #223029", color: "#eef6f1" } }} />
      {dragActive && workspaceHasItems && <div className="pointer-events-none fixed inset-3 z-40 grid place-items-center rounded-xl border-2 border-dashed border-primary bg-background/80 text-primary backdrop-blur-sm"><div className="text-center"><p className="text-lg font-semibold">Drop to import into {activeProject?.name}</p><p className="mt-1 text-[11px] text-muted-foreground">Files are processed locally</p></div></div>}
    </TooltipProvider>
  );
}
