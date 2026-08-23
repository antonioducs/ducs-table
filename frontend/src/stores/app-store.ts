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
} from "@/types";

export type AppTab = ProjectTabReference;
export type { QueryHistoryEntry } from "@/types";

export interface PanelState {
  sidebarSize: number;
  sqlSize: number;
  sqlCollapsed: boolean;
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
  activeSavedQueryIds: Record<string, string | undefined>;
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
  openTab: (projectId: string, sourceId: string) => void;
  openExternalTab: (projectId: string, relation: ExternalRelationInfo) => void;
  closeTab: (projectId: string, tabId: string) => void;
  selectTab: (projectId: string, tabId: string) => void;
  selectSource: (projectId: string, sourceId: string) => void;
  markExternalPlaceholder: (projectId: string, relationId: string, reason: "disconnected" | "missing") => void;

  setConnectionSchemas: (projectId: string, connectionId: string, schemas: string[]) => void;
  setExternalRelations: (projectId: string, connectionId: string, schema: string, relations: ExternalRelationInfo[]) => ProjectTabReference[];
  upsertExternalRelation: (projectId: string, relation: ExternalRelationInfo) => void;
  invalidateCatalog: (projectId: string, connectionId: string) => void;

  setDraft: (projectId: string, sql: string) => void;
  insertIntoDraft: (projectId: string, text: string) => void;
  newDraft: (projectId: string) => void;
  loadSavedQuery: (projectId: string, queryId: string) => void;
  upsertSavedQuery: (projectId: string, query: SavedQuery) => void;
  removeSavedQuery: (projectId: string, queryId: string) => void;
  addHistory: (projectId: string, entry: Omit<QueryHistoryEntry, "id" | "ranAt">) => void;
  nextResultName: (projectId: string) => string;

  upsertJob: (projectId: string, job: Job) => void;
  setPanel: (patch: Partial<PanelState>) => void;
  reset: () => void;
}

const initialPanel: PanelState = { sidebarSize: 19, sqlSize: 29, sqlCollapsed: false, aiSize: 28, aiCollapsed: true };

export function createEmptyProjectSession(): ProjectSession {
  return { version: 1, sqlDraft: "", tabs: [], history: [], resultSequence: 0 };
}

function sanitizeSource(projectId: string, source: SourceInfo): SourceInfo {
  const metadata = { ...source };
  delete metadata.previewRows;
  return { ...metadata, projectId };
}

function sanitizeSession(session?: ProjectSession): ProjectSession {
  const value = session ?? createEmptyProjectSession();
  const tabs = Array.isArray(value.tabs) ? value.tabs.map((tab) => ({ ...tab })) : [];
  return {
    version: Number.isFinite(value.version) && value.version > 0 ? Math.floor(value.version) : 1,
    sqlDraft: typeof value.sqlDraft === "string" ? value.sqlDraft : "",
    tabs,
    activeTabId: value.activeTabId && tabs.some((tab) => tab.id === value.activeTabId) ? value.activeTabId : undefined,
    history: Array.isArray(value.history) ? value.history.slice(0, 20) : [],
    resultSequence: Number.isFinite(value.resultSequence) && value.resultSequence >= 0 ? Math.floor(value.resultSequence) : 0,
  };
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

function localTab(source: SourceInfo): ProjectTabReference {
  return {
    id: `source:${source.id}`,
    kind: "local",
    sourceId: source.id,
    title: source.displayName,
    isResult: source.isEphemeral,
  };
}

function removeTabs(session: ProjectSession, predicate: (tab: ProjectTabReference) => boolean): ProjectSession {
  const removed = new Set(session.tabs.filter(predicate).map((tab) => tab.id));
  if (!removed.size) return session;
  const index = session.tabs.findIndex((tab) => tab.id === session.activeTabId);
  const tabs = session.tabs.filter((tab) => !removed.has(tab.id));
  return {
    ...session,
    tabs,
    activeTabId: session.activeTabId && removed.has(session.activeTabId)
      ? tabs[Math.min(Math.max(index, 0), tabs.length - 1)]?.id
      : session.activeTabId,
  };
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
  activeSavedQueryIds: {} as Record<string, string | undefined>,
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
            activeSavedQueryIds: { ...current.activeSavedQueryIds, [projectId]: undefined },
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
        const next = existing?.status === "ready" && (incoming.status === "preview" || incoming.status === "preparing")
          ? existing
          : { ...existing, ...incoming };
        const tabs = workspace.session.tabs.map((tab) => tab.sourceId === incoming.id ? { ...tab, ...localTab(next), id: tab.id } : tab);
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
      openTab: (projectId, sourceId) => set((current) => {
        const workspace = current.projectWorkspaces[projectId];
        const source = workspace?.sourcesById[sourceId];
        if (!workspace || !source) return current;
        const tab = localTab(source);
        const exists = workspace.session.tabs.some((item) => item.id === tab.id);
        const activeTabId = current.activeProjectId === projectId ? tab.id : workspace.session.activeTabId;
        return {
          projectWorkspaces: {
            ...current.projectWorkspaces,
            [projectId]: {
              ...workspace,
              session: { ...workspace.session, tabs: exists ? workspace.session.tabs : [...workspace.session.tabs, tab], activeTabId },
            },
          },
        };
      }),
      openExternalTab: (projectId, relation) => set((current) => {
        const workspace = current.projectWorkspaces[projectId];
        if (!workspace) return current;
        const tab: ProjectTabReference = {
          id: `external:${relation.id}`,
          kind: "external",
          relationId: relation.id,
          connectionId: relation.connectionId,
          catalog: relation.catalog,
          schema: relation.schema,
          relation: relation.name,
          relationType: relation.relationType,
          title: relation.name,
        };
        const exists = workspace.session.tabs.some((item) => item.id === tab.id);
        return {
          projectWorkspaces: {
            ...current.projectWorkspaces,
            [projectId]: {
              ...workspace,
              catalog: { ...workspace.catalog, relationsById: { ...workspace.catalog.relationsById, [relation.id]: relation } },
              session: {
                ...workspace.session,
                tabs: exists ? workspace.session.tabs.map((item) => item.id === tab.id ? tab : item) : [...workspace.session.tabs, tab],
                activeTabId: current.activeProjectId === projectId ? tab.id : workspace.session.activeTabId,
              },
            },
          },
        };
      }),
      closeTab: (projectId, tabId) => set((current) => {
        const workspace = current.projectWorkspaces[projectId];
        if (!workspace) return current;
        return { projectWorkspaces: { ...current.projectWorkspaces, [projectId]: { ...workspace, session: removeTabs(workspace.session, (tab) => tab.id === tabId) } } };
      }),
      selectTab: (projectId, tabId) => set((current) => {
        if (current.activeProjectId !== projectId) return current;
        const workspace = current.projectWorkspaces[projectId];
        if (!workspace?.session.tabs.some((tab) => tab.id === tabId)) return current;
        return { projectWorkspaces: { ...current.projectWorkspaces, [projectId]: { ...workspace, session: { ...workspace.session, activeTabId: tabId } } } };
      }),
      selectSource: (projectId, sourceId) => get().openTab(projectId, sourceId),
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

      setDraft: (projectId, sql) => set((current) => {
        const workspace = current.projectWorkspaces[projectId];
        if (!workspace) return current;
        return { projectWorkspaces: { ...current.projectWorkspaces, [projectId]: { ...workspace, session: { ...workspace.session, sqlDraft: sql } } } };
      }),
      insertIntoDraft: (projectId, text) => set((current) => {
        const workspace = current.projectWorkspaces[projectId];
        if (!workspace) return current;
        const existing = workspace.session.sqlDraft;
        const separator = existing && !/\s$/.test(existing) ? " " : "";
        return { projectWorkspaces: { ...current.projectWorkspaces, [projectId]: { ...workspace, session: { ...workspace.session, sqlDraft: `${existing}${separator}${text}` } } } };
      }),
      newDraft: (projectId) => set((current) => {
        const workspace = current.projectWorkspaces[projectId];
        if (!workspace) return current;
        return {
          projectWorkspaces: { ...current.projectWorkspaces, [projectId]: { ...workspace, session: { ...workspace.session, sqlDraft: "" } } },
          activeSavedQueryIds: { ...current.activeSavedQueryIds, [projectId]: undefined },
        };
      }),
      loadSavedQuery: (projectId, queryId) => set((current) => {
        if (current.activeProjectId !== projectId) return current;
        const workspace = current.projectWorkspaces[projectId];
        const query = workspace?.savedQueriesById[queryId];
        if (!workspace || !query) return current;
        return {
          projectWorkspaces: { ...current.projectWorkspaces, [projectId]: { ...workspace, session: { ...workspace.session, sqlDraft: query.sql } } },
          activeSavedQueryIds: { ...current.activeSavedQueryIds, [projectId]: queryId },
          panel: { ...current.panel, sqlCollapsed: false },
        };
      }),
      upsertSavedQuery: (projectId, query) => set((current) => {
        const workspace = current.projectWorkspaces[projectId];
        if (!workspace) return current;
        const saved = { ...query, projectId };
        const exists = Boolean(workspace.savedQueriesById[saved.id]);
        const savedQueryIds = (exists ? workspace.savedQueryIds : [...workspace.savedQueryIds, saved.id])
          .sort((left, right) => (left === saved.id ? saved.name : workspace.savedQueriesById[left]?.name ?? "").localeCompare(right === saved.id ? saved.name : workspace.savedQueriesById[right]?.name ?? ""));
        return {
          projectWorkspaces: { ...current.projectWorkspaces, [projectId]: { ...workspace, savedQueryIds, savedQueriesById: { ...workspace.savedQueriesById, [saved.id]: saved } } },
          activeSavedQueryIds: { ...current.activeSavedQueryIds, [projectId]: saved.id },
        };
      }),
      removeSavedQuery: (projectId, queryId) => set((current) => {
        const workspace = current.projectWorkspaces[projectId];
        if (!workspace) return current;
        const savedQueriesById = { ...workspace.savedQueriesById };
        delete savedQueriesById[queryId];
        return {
          projectWorkspaces: { ...current.projectWorkspaces, [projectId]: { ...workspace, savedQueryIds: workspace.savedQueryIds.filter((id) => id !== queryId), savedQueriesById } },
          activeSavedQueryIds: current.activeSavedQueryIds[projectId] === queryId ? { ...current.activeSavedQueryIds, [projectId]: undefined } : current.activeSavedQueryIds,
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

export const selectActiveSource = (state: AppState): SourceInfo | undefined => {
  const workspace = selectActiveWorkspace(state);
  const sourceId = workspace?.session.tabs.find((tab) => tab.id === workspace.session.activeTabId)?.sourceId;
  return sourceId ? workspace?.sourcesById[sourceId] : undefined;
};

export const selectActiveRelation = (state: AppState): ExternalRelationInfo | undefined => {
  const workspace = selectActiveWorkspace(state);
  const relationId = workspace?.session.tabs.find((tab) => tab.id === workspace.session.activeTabId)?.relationId;
  return relationId ? workspace?.catalog.relationsById[relationId] : undefined;
};

export const selectActiveJobs = (state: AppState): Job[] => selectJobs(state).filter((job) => job.state === "queued" || job.state === "running");
