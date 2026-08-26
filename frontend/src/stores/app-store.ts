import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type {
  Bootstrap,
  ConnectionInfo,
  ExternalRelationInfo,
  Job,
  Project,
  ProjectSession,
  ProjectTabReference,
  ProjectWorkspace,
  QueryHistoryEntry,
  SavedQuery,
  SourceInfo,
  SplitDirection,
  SQLDocument,
} from "@/types";
import {
  activeGroup,
  activeTabOf,
  closeTab as closeSessionTab,
  closeTabs,
  createSession,
  documentOf,
  findGroup,
  findTab,
  focusedDocumentId,
  focusGroup,
  moveTab as moveSessionTab,
  neighborGroupId,
  normalizeSession,
  openOrSplitSQLTab,
  openTab as openSessionTab,
  resizeSplit,
  selectTab as selectSessionTab,
  splitGroup as splitSessionGroup,
  splitWithNewSQLTab,
  splitWithNewTab,
  updateDocument as updateSessionDocument,
  type LayoutPath,
} from "@/lib/workbench";

export type AppTab = ProjectTabReference;
export type { QueryHistoryEntry } from "@/types";

export interface PanelState {
  sidebarSize: number;
  sidebarCollapsed: boolean;
  aiSize: number;
  aiCollapsed: boolean;
}

export interface ExternalCatalogState {
  schemasByConnection: Record<string, string[]>;
  relationsBySchema: Record<string, ExternalRelationInfo[]>;
  relationsById: Record<string, ExternalRelationInfo>;
}

export interface ProjectWorkspaceState {
  project: Project;
  sourceIds: string[];
  sourcesById: Record<string, SourceInfo>;
  savedQueryIds: string[];
  savedQueriesById: Record<string, SavedQuery>;
  connectionIds: string[];
  session: ProjectSession;
  catalog: ExternalCatalogState;
}

export interface AppState {
  projects: Record<string, Project>;
  projectIds: string[];
  activeProjectId?: string;
  switchingProjectId?: string;
  projectWorkspaces: Record<string, ProjectWorkspaceState>;
  connectionsById: Record<string, ConnectionInfo>;
  jobsById: Record<string, Job>;
  jobIds: string[];
  panel: PanelState;
  bootstrapped: boolean;

  bootstrap: (state: Bootstrap) => void;
  startProjectSwitch: (projectId: string) => void;
  cancelProjectSwitch: (projectId?: string) => void;
  commitProjectSwitch: (projectId: string, workspace: ProjectWorkspace) => boolean;
  clearActiveProject: () => void;
  upsertProject: (project: Project) => void;

  setGlobalConnections: (connections: ConnectionInfo[]) => void;
  upsertConnection: (connection: ConnectionInfo) => void;
  removeConnectionEverywhere: (connectionId: string) => void;
  attachConnection: (projectId: string, connectionId: string) => void;
  detachConnection: (projectId: string, connectionId: string) => void;

  upsertSource: (projectId: string, source: SourceInfo) => void;
  removeSource: (projectId: string, sourceId: string) => void;
  openTab: (projectId: string, sourceId: string, options?: OpenPlacement) => void;
  openExternalTab: (projectId: string, relation: ExternalRelationInfo, options?: OpenPlacement) => void;
  closeTab: (projectId: string, tabId: string) => void;
  closeOtherTabs: (projectId: string, groupId: string, keepTabId: string) => void;
  selectTab: (projectId: string, tabId: string) => void;
  selectSource: (projectId: string, sourceId: string) => void;
  markExternalPlaceholder: (projectId: string, relationId: string, reason: "disconnected" | "missing") => void;

  openSQLTab: (projectId: string, options?: { title?: string; sql?: string; savedQueryId?: string; groupId?: string }) => string | undefined;
  updateDocument: (projectId: string, documentId: string, patch: Partial<Omit<SQLDocument, "id">>) => void;
  splitGroup: (projectId: string, groupId: string, direction: SplitDirection, tabId?: string) => void;
  moveTab: (projectId: string, tabId: string, groupId: string, index?: number) => void;
  setActiveGroup: (projectId: string, groupId: string) => void;
  setLayoutSizes: (projectId: string, path: LayoutPath, sizes: number[]) => void;

  setConnectionSchemas: (projectId: string, connectionId: string, schemas: string[]) => void;
  setExternalRelations: (projectId: string, connectionId: string, schema: string, relations: ExternalRelationInfo[]) => ProjectTabReference[];
  upsertExternalRelation: (projectId: string, relation: ExternalRelationInfo) => void;
  invalidateCatalog: (projectId: string, connectionId: string) => void;

  setDraft: (projectId: string, sql: string) => void;
  insertIntoDraft: (projectId: string, text: string) => void;
  newDraft: (projectId: string) => void;
  loadSavedQuery: (projectId: string, queryId: string) => void;
  bindSavedQuery: (projectId: string, documentId: string, query: SavedQuery) => void;
  upsertSavedQuery: (projectId: string, query: SavedQuery) => void;
  removeSavedQuery: (projectId: string, queryId: string) => void;
  addHistory: (projectId: string, entry: Omit<QueryHistoryEntry, "id" | "ranAt">) => void;
  nextResultName: (projectId: string) => string;

  upsertJob: (projectId: string, job: Job) => void;
  setPanel: (patch: Partial<PanelState>) => void;
  reset: () => void;
}

const initialPanel: PanelState = { sidebarSize: 19, sidebarCollapsed: false, aiSize: 28, aiCollapsed: true };

/** Where a newly opened tab should land inside the workbench. */
export interface OpenPlacement {
  groupId?: string;
  activate?: boolean;
  /** Split the target group instead of appending to it. */
  split?: SplitDirection;
  /** Prefer the group displayed next to `groupId`, creating one when needed. */
  beside?: boolean;
}

export function createEmptyProjectSession(): ProjectSession {
  return createSession();
}

function sanitizeSource(projectId: string, source: SourceInfo): SourceInfo {
  const metadata = { ...source };
  delete metadata.previewRows;
  return { ...metadata, projectId };
}

function sanitizeSession(session?: ProjectSession): ProjectSession {
  return normalizeSession(session ?? createEmptyProjectSession());
}

function workspaceState(workspace: ProjectWorkspace): ProjectWorkspaceState {
  const projectId = workspace.project.id;
  const sources = (workspace.sources ?? []).map((source) => sanitizeSource(projectId, source));
  const queries = (workspace.savedQueries ?? []).map((query) => ({ ...query, projectId }));
  const externalRelations = workspace.externalRelations ?? [];
  const relationsBySchema = externalRelations.reduce<Record<string, ExternalRelationInfo[]>>((groups, relation) => {
    const key = `${relation.connectionId}:${relation.schema}`;
    groups[key] = [...(groups[key] ?? []), relation];
    return groups;
  }, {});
  return {
    project: workspace.project,
    sourceIds: sources.map((source) => source.id),
    sourcesById: Object.fromEntries(sources.map((source) => [source.id, source])),
    savedQueryIds: queries.map((query) => query.id),
    savedQueriesById: Object.fromEntries(queries.map((query) => [query.id, query])),
    connectionIds: [...new Set((workspace.connections ?? []).map((connection) => connection.id))],
    session: sanitizeSession(workspace.session),
    catalog: {
      schemasByConnection: {},
      relationsBySchema,
      relationsById: Object.fromEntries(externalRelations.map((relation) => [relation.id, relation])),
    },
  };
}

// OpenProject may race with a job finishing in a previously loaded target
// project. When that happens, frontend mutations observed after the request
// started are newer than the response snapshot and must not be overwritten.
export function preserveWorkspaceMutations(
  response: ProjectWorkspace,
  current: ProjectWorkspaceState,
  connectionsById: Record<string, ConnectionInfo>,
): ProjectWorkspace {
  const responseConnections = Object.fromEntries(response.connections.map((connection) => [connection.id, connection]));
  const responseRelations = Object.fromEntries((response.externalRelations ?? []).map((relation) => [relation.id, relation]));
  return {
    ...response,
    sources: current.sourceIds.map((id) => current.sourcesById[id]).filter(Boolean),
    savedQueries: current.savedQueryIds.map((id) => current.savedQueriesById[id]).filter(Boolean),
    connections: current.connectionIds.map((id) => connectionsById[id] ?? responseConnections[id]).filter(Boolean),
    externalRelations: Object.values({ ...responseRelations, ...current.catalog.relationsById }),
    session: current.session,
  };
}

function localTabFields(source: SourceInfo): Omit<ProjectTabReference, "id"> {
  return {
    kind: "local",
    sourceId: source.id,
    title: source.displayName,
    isResult: source.isEphemeral,
  };
}

function removeTabs(session: ProjectSession, predicate: (tab: ProjectTabReference) => boolean): ProjectSession {
  return closeTabs(session, predicate);
}

/** Resolves an OpenPlacement into the group that should receive the tab. */
function placementGroupId(session: ProjectSession, placement?: OpenPlacement): string {
  const base = placement?.groupId && findGroup(session, placement.groupId) ? placement.groupId : activeGroup(session).id;
  if (!placement?.beside) return base;
  return neighborGroupId(session, base) ?? base;
}

function applySession(
  current: AppState,
  projectId: string,
  update: (session: ProjectSession, workspace: ProjectWorkspaceState) => ProjectSession,
): Partial<AppState> | AppState {
  const workspace = current.projectWorkspaces[projectId];
  if (!workspace) return current;
  const session = update(workspace.session, workspace);
  if (session === workspace.session) return current;
  return { projectWorkspaces: { ...current.projectWorkspaces, [projectId]: { ...workspace, session } } };
}

const dataInitial = {
  projects: {} as Record<string, Project>,
  projectIds: [] as string[],
  activeProjectId: undefined as string | undefined,
  switchingProjectId: undefined as string | undefined,
  projectWorkspaces: {} as Record<string, ProjectWorkspaceState>,
  connectionsById: {} as Record<string, ConnectionInfo>,
  jobsById: {} as Record<string, Job>,
  jobIds: [] as string[],
  panel: initialPanel,
  bootstrapped: false,
};

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      ...dataInitial,
      bootstrap: (state) => set((current) => {
        const projects = Object.fromEntries((state.projects ?? []).map((project) => [project.id, project]));
        const projectIds = (state.projects ?? []).map((project) => project.id);
        const projectWorkspaces = { ...current.projectWorkspaces };
        const connectionsById = { ...current.connectionsById };
        if (state.workspace?.project.id) {
          projects[state.workspace.project.id] = state.workspace.project;
          if (!projectIds.includes(state.workspace.project.id)) projectIds.push(state.workspace.project.id);
          projectWorkspaces[state.workspace.project.id] = workspaceState(state.workspace);
          for (const connection of state.workspace.connections ?? []) connectionsById[connection.id] = connection;
        }
        const jobsById = Object.fromEntries((state.jobs ?? []).map((job) => [job.id, { ...job, projectId: job.projectId }]));
        return {
          projects,
          projectIds,
          activeProjectId: state.activeProjectId && projectWorkspaces[state.activeProjectId] ? state.activeProjectId : state.workspace?.project.id,
          switchingProjectId: undefined,
          projectWorkspaces,
          connectionsById,
          jobsById,
          jobIds: (state.jobs ?? []).map((job) => job.id),
          bootstrapped: true,
        };
      }),
      startProjectSwitch: (projectId) => set({ switchingProjectId: projectId }),
      cancelProjectSwitch: (projectId) => set((current) => projectId && current.switchingProjectId !== projectId ? current : { switchingProjectId: undefined }),
      commitProjectSwitch: (projectId, workspace) => {
        if (workspace.project.id !== projectId) return false;
        let committed = false;
        set((current) => {
          if (current.switchingProjectId && current.switchingProjectId !== projectId) return current;
          const nextWorkspace = workspaceState(workspace);
          const connectionsById = { ...current.connectionsById };
          for (const connection of workspace.connections ?? []) connectionsById[connection.id] = connection;
          committed = true;
          return {
            projects: { ...current.projects, [projectId]: workspace.project },
            projectIds: current.projectIds.includes(projectId) ? current.projectIds : [...current.projectIds, projectId],
            projectWorkspaces: { ...current.projectWorkspaces, [projectId]: nextWorkspace },
            connectionsById,
            activeProjectId: projectId,
            switchingProjectId: undefined,
          };
        });
        return committed;
      },
      clearActiveProject: () => set({ activeProjectId: undefined, switchingProjectId: undefined }),
      upsertProject: (project) => set((current) => {
        const workspace = current.projectWorkspaces[project.id];
        return {
          projects: { ...current.projects, [project.id]: project },
          projectIds: current.projectIds.includes(project.id) ? current.projectIds : [...current.projectIds, project.id],
          projectWorkspaces: workspace
            ? { ...current.projectWorkspaces, [project.id]: { ...workspace, project } }
            : current.projectWorkspaces,
        };
      }),

      setGlobalConnections: (connections) => set((current) => ({
        connectionsById: {
          ...current.connectionsById,
          ...Object.fromEntries(connections.map((connection) => [connection.id, connection])),
        },
      })),
      upsertConnection: (connection) => set((current) => ({
        connectionsById: {
          ...current.connectionsById,
          [connection.id]: { ...current.connectionsById[connection.id], ...connection },
        },
      })),
      removeConnectionEverywhere: (connectionId) => set((current) => {
        const connectionsById = { ...current.connectionsById };
        delete connectionsById[connectionId];
        const projectWorkspaces = Object.fromEntries(Object.entries(current.projectWorkspaces).map(([projectId, workspace]) => {
          const catalog = workspace.catalog;
          const relationsForConnection = new Set(Object.values(catalog.relationsById)
            .filter((relation) => relation.connectionId === connectionId)
            .map((relation) => relation.id));
          return [projectId, {
            ...workspace,
            connectionIds: workspace.connectionIds.filter((id) => id !== connectionId),
            session: removeTabs(workspace.session, (tab) => tab.connectionId === connectionId || Boolean(tab.relationId && relationsForConnection.has(tab.relationId))),
            catalog: {
              schemasByConnection: Object.fromEntries(Object.entries(catalog.schemasByConnection).filter(([id]) => id !== connectionId)),
              relationsBySchema: Object.fromEntries(Object.entries(catalog.relationsBySchema).filter(([key]) => !key.startsWith(`${connectionId}:`))),
              relationsById: Object.fromEntries(Object.entries(catalog.relationsById).filter(([, relation]) => relation.connectionId !== connectionId)),
            },
          }];
        }));
        return { connectionsById, projectWorkspaces };
      }),
      attachConnection: (projectId, connectionId) => set((current) => {
        const workspace = current.projectWorkspaces[projectId];
        if (!workspace || workspace.connectionIds.includes(connectionId)) return current;
        return { projectWorkspaces: { ...current.projectWorkspaces, [projectId]: { ...workspace, connectionIds: [...workspace.connectionIds, connectionId] } } };
      }),
      detachConnection: (projectId, connectionId) => set((current) => {
        const workspace = current.projectWorkspaces[projectId];
        if (!workspace) return current;
        const relationIds = new Set(Object.values(workspace.catalog.relationsById).filter((relation) => relation.connectionId === connectionId).map((relation) => relation.id));
        return {
          projectWorkspaces: {
            ...current.projectWorkspaces,
            [projectId]: {
              ...workspace,
              connectionIds: workspace.connectionIds.filter((id) => id !== connectionId),
              session: removeTabs(workspace.session, (tab) => tab.connectionId === connectionId || Boolean(tab.relationId && relationIds.has(tab.relationId))),
              catalog: {
                schemasByConnection: Object.fromEntries(Object.entries(workspace.catalog.schemasByConnection).filter(([id]) => id !== connectionId)),
                relationsBySchema: Object.fromEntries(Object.entries(workspace.catalog.relationsBySchema).filter(([key]) => !key.startsWith(`${connectionId}:`))),
                relationsById: Object.fromEntries(Object.entries(workspace.catalog.relationsById).filter(([, relation]) => relation.connectionId !== connectionId)),
              },
            },
          },
        };
      }),

      upsertSource: (projectId, source) => set((current) => {
        const workspace = current.projectWorkspaces[projectId];
        if (!workspace) return current;
        const incoming = sanitizeSource(projectId, source);
        const existing = workspace.sourcesById[incoming.id];
        const terminal = existing?.status === "ready" || existing?.status === "failed" || existing?.status === "cancelled";
        const staleAfterReady = existing?.status === "ready" && incoming.status !== "ready";
        const next = (terminal && (incoming.status === "preview" || incoming.status === "preparing")) || staleAfterReady
          ? existing
          : { ...existing, ...incoming };
        const tabs = workspace.session.tabs.map((tab) => tab.sourceId === incoming.id ? { ...tab, ...localTabFields(next) } : tab);
        return {
          projectWorkspaces: {
            ...current.projectWorkspaces,
            [projectId]: {
              ...workspace,
              sourceIds: existing ? workspace.sourceIds : [...workspace.sourceIds, incoming.id],
              sourcesById: { ...workspace.sourcesById, [incoming.id]: next },
              session: tabs === workspace.session.tabs ? workspace.session : { ...workspace.session, tabs },
            },
          },
        };
      }),
      removeSource: (projectId, sourceId) => set((current) => {
        const workspace = current.projectWorkspaces[projectId];
        if (!workspace) return current;
        const sourcesById = { ...workspace.sourcesById };
        delete sourcesById[sourceId];
        return {
          projectWorkspaces: {
            ...current.projectWorkspaces,
            [projectId]: {
              ...workspace,
              sourceIds: workspace.sourceIds.filter((id) => id !== sourceId),
              sourcesById,
              session: removeTabs(workspace.session, (tab) => tab.sourceId === sourceId),
            },
          },
        };
      }),
      openTab: (projectId, sourceId, options) => set((current) => applySession(current, projectId, (session, workspace) => {
        const source = workspace.sourcesById[sourceId];
        if (!source) return session;
        const fields = localTabFields(source);
        const activate = options?.activate !== false && current.activeProjectId === projectId;
        const existing = session.tabs.find((tab) => tab.kind === "local" && tab.sourceId === sourceId);
        if (existing) {
          const merged = session.tabs.map((tab) => tab.id === existing.id ? { ...tab, ...fields } : tab);
          const withTab = { ...session, tabs: merged };
          return activate ? selectSessionTab(withTab, existing.id) : withTab;
        }
        const groupId = placementGroupId(session, options);
        if (options?.split) return splitWithNewTab(session, groupId, options.split, fields);
        return openSessionTab(session, fields, { groupId, activate });
      })),
      openExternalTab: (projectId, relation, options) => set((current) => {
        const workspace = current.projectWorkspaces[projectId];
        if (!workspace) return current;
        const fields: Omit<ProjectTabReference, "id"> = {
          kind: "external",
          relationId: relation.id,
          connectionId: relation.connectionId,
          catalog: relation.catalog,
          schema: relation.schema,
          relation: relation.name,
          relationType: relation.relationType,
          title: relation.name,
        };
        const activate = options?.activate !== false && current.activeProjectId === projectId;
        const session = workspace.session;
        const existing = session.tabs.find((tab) => tab.relationId === relation.id);
        let next: ProjectSession;
        if (existing) {
          const merged = session.tabs.map((tab) => tab.id === existing.id ? { ...tab, ...fields, placeholderReason: undefined } : tab);
          next = activate ? selectSessionTab({ ...session, tabs: merged }, existing.id) : { ...session, tabs: merged };
        } else {
          const groupId = placementGroupId(session, options);
          next = options?.split
            ? splitWithNewTab(session, groupId, options.split, fields)
            : openSessionTab(session, fields, { groupId, activate });
        }
        return {
          projectWorkspaces: {
            ...current.projectWorkspaces,
            [projectId]: {
              ...workspace,
              catalog: { ...workspace.catalog, relationsById: { ...workspace.catalog.relationsById, [relation.id]: relation } },
              session: next,
            },
          },
        };
      }),
      closeTab: (projectId, tabId) => set((current) => applySession(current, projectId, (session) => closeSessionTab(session, tabId))),
      closeOtherTabs: (projectId, groupId, keepTabId) => set((current) => applySession(current, projectId, (session) => {
        const group = findGroup(session, groupId);
        if (!group) return session;
        return group.tabIds
          .filter((tabId) => tabId !== keepTabId)
          .reduce((currentSession, tabId) => closeSessionTab(currentSession, tabId), session);
      })),
      selectTab: (projectId, tabId) => set((current) => {
        if (current.activeProjectId !== projectId) return current;
        return applySession(current, projectId, (session) => selectSessionTab(session, tabId));
      }),
      selectSource: (projectId, sourceId) => get().openTab(projectId, sourceId),

      openSQLTab: (projectId, options) => {
        let documentId: string | undefined;
        set((current) => applySession(current, projectId, (session) => {
          const opened = openOrSplitSQLTab(session, options?.groupId ? { ...options, groupId: placementGroupId(session, options) } : options);
          documentId = opened.documentId;
          return opened.session;
        }));
        return documentId;
      },
      updateDocument: (projectId, documentId, patch) => set((current) => applySession(current, projectId, (session) => updateSessionDocument(session, documentId, patch))),
      splitGroup: (projectId, groupId, direction, tabId) => set((current) => applySession(current, projectId, (session) => {
        const split = splitSessionGroup(session, groupId, direction, tabId);
        if (split !== session) return split;
        // A lone SQL tab cannot be duplicated (one document, one tab), so the
        // split starts a fresh query beside it instead.
        const target = findTab(session, tabId ?? findGroup(session, groupId)?.activeTabId);
        return target?.kind === "sql" ? splitWithNewSQLTab(session, groupId, direction).session : session;
      })),
      moveTab: (projectId, tabId, groupId, index) => set((current) => applySession(current, projectId, (session) => moveSessionTab(session, tabId, groupId, index))),
      setActiveGroup: (projectId, groupId) => set((current) => applySession(current, projectId, (session) => focusGroup(session, groupId))),
      setLayoutSizes: (projectId, path, sizes) => set((current) => applySession(current, projectId, (session) => resizeSplit(session, path, sizes))),
      markExternalPlaceholder: (projectId, relationId, reason) => set((current) => {
        const workspace = current.projectWorkspaces[projectId];
        if (!workspace) return current;
        return {
          projectWorkspaces: {
            ...current.projectWorkspaces,
            [projectId]: {
              ...workspace,
              session: { ...workspace.session, tabs: workspace.session.tabs.map((tab) => tab.relationId === relationId ? { ...tab, kind: "placeholder", placeholderReason: reason } : tab) },
            },
          },
        };
      }),

      setConnectionSchemas: (projectId, connectionId, schemas) => set((current) => {
        const workspace = current.projectWorkspaces[projectId];
        if (!workspace) return current;
        return { projectWorkspaces: { ...current.projectWorkspaces, [projectId]: { ...workspace, catalog: { ...workspace.catalog, schemasByConnection: { ...workspace.catalog.schemasByConnection, [connectionId]: schemas } } } } };
      }),
      setExternalRelations: (projectId, connectionId, schema, relations) => {
        let removed: ProjectTabReference[] = [];
        set((current) => {
          const workspace = current.projectWorkspaces[projectId];
          if (!workspace) return current;
          const available = new Set(relations.map((relation) => relation.id));
          removed = workspace.session.tabs.filter((tab) => tab.connectionId === connectionId && tab.schema === schema && Boolean(tab.relationId) && !available.has(tab.relationId!));
          const key = `${connectionId}:${schema}`;
          const relationsById = { ...workspace.catalog.relationsById };
          for (const [id, relation] of Object.entries(relationsById)) {
            if (relation.connectionId === connectionId && relation.schema === schema && !available.has(id)) delete relationsById[id];
          }
          for (const relation of relations) relationsById[relation.id] = relation;
          const session = removeTabs(workspace.session, (tab) => removed.some((item) => item.id === tab.id));
          return {
            projectWorkspaces: {
              ...current.projectWorkspaces,
              [projectId]: {
                ...workspace,
                session,
                catalog: {
                  ...workspace.catalog,
                  relationsBySchema: { ...workspace.catalog.relationsBySchema, [key]: relations },
                  relationsById,
                },
              },
            },
          };
        });
        return removed;
      },
      upsertExternalRelation: (projectId, relation) => set((current) => {
        const workspace = current.projectWorkspaces[projectId];
        if (!workspace) return current;
        return {
          projectWorkspaces: {
            ...current.projectWorkspaces,
            [projectId]: {
              ...workspace,
              catalog: { ...workspace.catalog, relationsById: { ...workspace.catalog.relationsById, [relation.id]: relation } },
              session: {
                ...workspace.session,
                tabs: workspace.session.tabs.map((tab) => tab.relationId === relation.id ? {
                  ...tab,
                  kind: "external",
                  title: relation.name,
                  connectionId: relation.connectionId,
                  schema: relation.schema,
                  placeholderReason: undefined,
                } : tab),
              },
            },
          },
        };
      }),
      invalidateCatalog: (projectId, connectionId) => set((current) => {
        const workspace = current.projectWorkspaces[projectId];
        if (!workspace) return current;
        return {
          projectWorkspaces: {
            ...current.projectWorkspaces,
            [projectId]: {
              ...workspace,
              catalog: {
                schemasByConnection: Object.fromEntries(Object.entries(workspace.catalog.schemasByConnection).filter(([id]) => id !== connectionId)),
                relationsBySchema: Object.fromEntries(Object.entries(workspace.catalog.relationsBySchema).filter(([key]) => !key.startsWith(`${connectionId}:`))),
                relationsById: Object.fromEntries(Object.entries(workspace.catalog.relationsById).map(([id, relation]) => [id, relation.connectionId === connectionId ? { ...relation, columns: [], defaultOrder: [], pagingStable: false } : relation])),
              },
            },
          },
        };
      }),

      // Draft helpers target the focused SQL tab and open one when the workbench
      // has no query editor yet, so the sidebar and AI panel keep working.
      setDraft: (projectId, sql) => set((current) => applySession(current, projectId, (session) => {
        const documentId = focusedDocumentId(session);
        if (documentId) return updateSessionDocument(session, documentId, { sql });
        return openOrSplitSQLTab(session, { sql }).session;
      })),
      insertIntoDraft: (projectId, text) => set((current) => applySession(current, projectId, (session) => {
        const documentId = focusedDocumentId(session);
        if (!documentId) return openOrSplitSQLTab(session, { sql: text }).session;
        const document = documentOf(session, documentId);
        const existing = document?.sql ?? "";
        const separator = existing && !/\s$/.test(existing) ? " " : "";
        return updateSessionDocument(session, documentId, { sql: `${existing}${separator}${text}` });
      })),
      newDraft: (projectId) => set((current) => applySession(current, projectId, (session) => openOrSplitSQLTab(session).session)),
      loadSavedQuery: (projectId, queryId) => set((current) => {
        if (current.activeProjectId !== projectId) return current;
        return applySession(current, projectId, (session, workspace) => {
          const query = workspace.savedQueriesById[queryId];
          if (!query) return session;
          const openDocument = session.documents.find((document) => document.savedQueryId === queryId);
          if (openDocument) {
            const tab = session.tabs.find((item) => item.documentId === openDocument.id);
            const refreshed = updateSessionDocument(session, openDocument.id, { sql: query.sql, title: query.name });
            return tab ? selectSessionTab(refreshed, tab.id) : refreshed;
          }
          return openOrSplitSQLTab(session, { title: query.name, sql: query.sql, savedQueryId: queryId }).session;
        });
      }),
      bindSavedQuery: (projectId, documentId, query) => set((current) => applySession(current, projectId, (session) => updateSessionDocument(session, documentId, { savedQueryId: query.id, title: query.name }))),
      upsertSavedQuery: (projectId, query) => set((current) => {
        const workspace = current.projectWorkspaces[projectId];
        if (!workspace) return current;
        const saved = { ...query, projectId };
        const exists = Boolean(workspace.savedQueriesById[saved.id]);
        const renamed = exists && workspace.savedQueriesById[saved.id].name !== saved.name;
        const savedQueryIds = (exists ? workspace.savedQueryIds : [...workspace.savedQueryIds, saved.id])
          .sort((left, right) => (left === saved.id ? saved.name : workspace.savedQueriesById[left]?.name ?? "").localeCompare(right === saved.id ? saved.name : workspace.savedQueriesById[right]?.name ?? ""));
        const session = renamed
          ? workspace.session.documents
            .filter((document) => document.savedQueryId === saved.id)
            .reduce((current, document) => updateSessionDocument(current, document.id, { title: saved.name }), workspace.session)
          : workspace.session;
        return {
          projectWorkspaces: { ...current.projectWorkspaces, [projectId]: { ...workspace, savedQueryIds, savedQueriesById: { ...workspace.savedQueriesById, [saved.id]: saved }, session } },
        };
      }),
      removeSavedQuery: (projectId, queryId) => set((current) => {
        const workspace = current.projectWorkspaces[projectId];
        if (!workspace) return current;
        const savedQueriesById = { ...workspace.savedQueriesById };
        delete savedQueriesById[queryId];
        // Open editors keep their text; they just stop tracking the saved query.
        const documents = workspace.session.documents.map((document) => document.savedQueryId === queryId ? { ...document, savedQueryId: undefined } : document);
        return {
          projectWorkspaces: {
            ...current.projectWorkspaces,
            [projectId]: {
              ...workspace,
              savedQueryIds: workspace.savedQueryIds.filter((id) => id !== queryId),
              savedQueriesById,
              session: { ...workspace.session, documents },
            },
          },
        };
      }),
      addHistory: (projectId, entry) => set((current) => {
        const workspace = current.projectWorkspaces[projectId];
        if (!workspace) return current;
        const history = [{ ...entry, id: crypto.randomUUID(), ranAt: new Date().toISOString() }, ...workspace.session.history].slice(0, 20);
        return { projectWorkspaces: { ...current.projectWorkspaces, [projectId]: { ...workspace, session: { ...workspace.session, history } } } };
      }),
      nextResultName: (projectId) => {
        let name = "Result 1";
        set((current) => {
          const workspace = current.projectWorkspaces[projectId];
          if (!workspace) return current;
          const resultSequence = workspace.session.resultSequence + 1;
          name = `Result ${resultSequence}`;
          return { projectWorkspaces: { ...current.projectWorkspaces, [projectId]: { ...workspace, session: { ...workspace.session, resultSequence } } } };
        });
        return name;
      },

      upsertJob: (projectId, job) => set((current) => {
        const normalized = { ...job, projectId };
        return {
          jobsById: { ...current.jobsById, [normalized.id]: { ...current.jobsById[normalized.id], ...normalized } },
          jobIds: current.jobIds.includes(normalized.id) ? current.jobIds : [normalized.id, ...current.jobIds],
        };
      }),
      setPanel: (patch) => set((current) => ({ panel: { ...current.panel, ...patch } })),
      reset: () => set({ ...dataInitial, panel: { ...initialPanel } }),
    }),
    {
      name: "ducs-table:layout:v2",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ panel: state.panel }) as AppState,
      merge: (persisted, current) => {
        const saved = persisted as Partial<AppState>;
        return { ...current, panel: { ...current.panel, ...saved.panel } };
      },
    },
  ),
);

export const selectProjects = (state: AppState): Project[] => state.projectIds.map((id) => state.projects[id]).filter(Boolean);
export const selectActiveWorkspace = (state: AppState): ProjectWorkspaceState | undefined => state.activeProjectId ? state.projectWorkspaces[state.activeProjectId] : undefined;
export const selectWorkspaceSources = (workspace?: ProjectWorkspaceState): SourceInfo[] => workspace ? workspace.sourceIds.map((id) => workspace.sourcesById[id]).filter(Boolean) : [];
export const selectWorkspaceQueries = (workspace?: ProjectWorkspaceState): SavedQuery[] => workspace ? workspace.savedQueryIds.map((id) => workspace.savedQueriesById[id]).filter(Boolean) : [];
export const selectWorkspaceConnections = (state: AppState, workspace?: ProjectWorkspaceState): ConnectionInfo[] => workspace ? workspace.connectionIds.map((id) => state.connectionsById[id]).filter(Boolean) : [];
export const selectJobs = (state: AppState): Job[] => state.jobIds.map((id) => state.jobsById[id]).filter(Boolean);
export const selectProjectJobs = (state: AppState, projectId?: string): Job[] => selectJobs(state).filter((job) => job.projectId === projectId);

/** Tab focused in the active editor group. */
export const selectActiveTab = (state: AppState): ProjectTabReference | undefined => {
  const workspace = selectActiveWorkspace(state);
  return workspace ? activeTabOf(workspace.session) : undefined;
};

export const selectActiveSource = (state: AppState): SourceInfo | undefined => {
  const workspace = selectActiveWorkspace(state);
  const sourceId = workspace ? activeTabOf(workspace.session)?.sourceId : undefined;
  return sourceId ? workspace?.sourcesById[sourceId] : undefined;
};

export const selectActiveRelation = (state: AppState): ExternalRelationInfo | undefined => {
  const workspace = selectActiveWorkspace(state);
  const relationId = workspace ? activeTabOf(workspace.session)?.relationId : undefined;
  return relationId ? workspace?.catalog.relationsById[relationId] : undefined;
};

/** SQL document a global action (AI panel, sidebar insert) should target. */
export const selectFocusedDocument = (state: AppState): SQLDocument | undefined => {
  const workspace = selectActiveWorkspace(state);
  if (!workspace) return undefined;
  return documentOf(workspace.session, focusedDocumentId(workspace.session));
};

export const selectActiveJobs = (state: AppState): Job[] => selectJobs(state).filter((job) => job.state === "queued" || job.state === "running");
