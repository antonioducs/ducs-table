import type {
  AppErrorInfo,
  Bootstrap,
  BridgeEventMap,
  CellValueResult,
  ConnectionInfo,
  ConnectionInput,
  CountRowsRequest,
  ExportRequest,
  ExternalRelationInfo,
  GetCellValueRequest,
  ImportPathsRequest,
  ImportPathsResult,
  ImportStartResult,
  Job,
  Project,
  ProjectSession,
  ProjectTabReference,
  ProjectWorkspace,
  QueryHistoryEntry,
  QueryRequest,
  QueryResult,
  RowsRequest,
  SavedQuery,
  SaveQueryRequest,
  SaveResultAsTableRequest,
  SourceInfo,
  TestConnectionInput,
  UpdateConnectionInput,
  WorkbookSheets,
  XLSXImportRequest,
} from "@/types";
import { installWailsErrorNormalizer } from "@/lib/wails-error-normalizer";

type AppAPI = NonNullable<NonNullable<NonNullable<Window["go"]>["main"]>["App"]>;
type RawObject = Record<string, unknown>;

const friendlyMissingMessage =
  "Duc's Table desktop bridge is unavailable. Run the app through Wails to use local files.";

function app(): AppAPI {
  installWailsErrorNormalizer();
  const api = window.go?.main?.App;
  if (!api) throw new Error(friendlyMissingMessage);
  return api;
}

function object(value: unknown): RawObject {
  return value && typeof value === "object" ? value as RawObject : {};
}

function string(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function errorInfo(value: unknown): AppErrorInfo | undefined {
  if (!value) return undefined;
  if (typeof value === "string") return { message: value };
  const raw = object(value);
  return {
    message: string(raw.message, "An unexpected local processing error occurred."),
    code: typeof raw.code === "string" ? raw.code : undefined,
    details: raw.details && typeof raw.details === "object" ? raw.details as Record<string, unknown> : undefined,
  };
}

/** Keep Go/legacy JSON names at the bridge boundary; the normalized store strips transient preview rows. */
export function normalizeSource(value: SourceInfo | RawObject, projectId = ""): SourceInfo {
  const raw = object(value);
  const inferredStatus = raw.status ?? (raw.error ? "failed" : "ready");
  return {
    projectId: string(raw.projectId, projectId),
    id: string(raw.id),
    displayName: string(raw.displayName ?? raw.name, "Untitled source"),
    tableName: string(raw.tableName ?? raw.sqlName),
    sourcePath: typeof raw.sourcePath === "string" ? raw.sourcePath : undefined,
    kind: string(raw.kind ?? raw.sourceType, "table"),
    sheet: typeof raw.sheet === "string" && raw.sheet ? raw.sheet : undefined,
    size: typeof raw.size === "number" ? raw.size : undefined,
    rowCount: typeof raw.rowCount === "number" ? raw.rowCount : null,
    status: inferredStatus as SourceInfo["status"],
    isEphemeral: Boolean(raw.isEphemeral),
    columns: Array.isArray(raw.columns) ? raw.columns as SourceInfo["columns"] : [],
    previewRows: Array.isArray(raw.previewRows) ? raw.previewRows as SourceInfo["previewRows"] : undefined,
    error: errorInfo(raw.error),
    originalSQL: typeof (raw.originalSQL ?? raw.originalSql) === "string"
      ? String(raw.originalSQL ?? raw.originalSql)
      : undefined,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : undefined,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : undefined,
    snapshot: raw.snapshot && typeof raw.snapshot === "object" ? raw.snapshot as SourceInfo["snapshot"] : undefined,
  };
}

export function normalizePreviewSource(value: SourceInfo | RawObject, projectId = ""): SourceInfo {
  const raw = object(value);
  const source = normalizeSource(raw, projectId);
  return Array.isArray(raw.previewRows) ? { ...source, previewRows: raw.previewRows as SourceInfo["previewRows"] } : source;
}

function normalizeSources(values: unknown, projectId: string): SourceInfo[] {
  return Array.isArray(values)
    ? values.filter((value) => Boolean(value) && typeof value === "object").map((value) => normalizeSource(value as RawObject, projectId))
    : [];
}

function normalizePreviewSources(values: unknown, projectId: string): SourceInfo[] {
  return Array.isArray(values)
    ? values.filter((value) => Boolean(value) && typeof value === "object").map((value) => normalizePreviewSource(value as RawObject, projectId))
    : [];
}

export function normalizeProject(value: Project | RawObject): Project {
  const raw = object(value);
  return {
    id: string(raw.id),
    name: string(raw.name, "Untitled project"),
    description: string(raw.description),
    archivedAt: typeof raw.archivedAt === "string" && raw.archivedAt ? raw.archivedAt : undefined,
    lastOpenedAt: string(raw.lastOpenedAt),
    createdAt: string(raw.createdAt),
    updatedAt: string(raw.updatedAt),
  };
}

function normalizeTab(value: unknown): ProjectTabReference | undefined {
  const raw = object(value);
  const id = string(raw.id);
  if (!id) return undefined;
  const legacyKind = string(raw.kind);
  const kind: ProjectTabReference["kind"] = legacyKind === "external"
    ? "external"
    : legacyKind === "placeholder"
      ? "placeholder"
      : "local";
  return {
    id,
    kind,
    title: string(raw.title, "Untitled"),
    sourceId: typeof raw.sourceId === "string" ? raw.sourceId : undefined,
    relationId: typeof raw.relationId === "string" ? raw.relationId : undefined,
    connectionId: typeof raw.connectionId === "string" ? raw.connectionId : undefined,
    catalog: typeof raw.catalog === "string" ? raw.catalog : undefined,
    schema: typeof raw.schema === "string" ? raw.schema : undefined,
    relation: typeof raw.relation === "string" ? raw.relation : undefined,
    relationType: typeof raw.relationType === "string" ? raw.relationType : undefined,
    isResult: typeof raw.isResult === "boolean" ? raw.isResult : legacyKind === "result",
    placeholderReason: raw.placeholderReason === "missing" ? "missing" : raw.placeholderReason === "disconnected" ? "disconnected" : undefined,
  };
}

function normalizeHistory(value: unknown): QueryHistoryEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): QueryHistoryEntry[] => {
    const raw = object(entry);
    if (typeof raw.sql !== "string") return [];
    return [{
      id: string(raw.id, crypto.randomUUID()),
      sql: raw.sql,
      ranAt: string(raw.ranAt),
      durationMs: typeof raw.durationMs === "number" ? raw.durationMs : undefined,
      status: raw.status === "error" ? "error" : "success",
    }];
  }).slice(0, 20);
}

export function normalizeProjectSession(value: ProjectSession | RawObject | undefined): ProjectSession {
  const raw = object(value);
  const tabs = Array.isArray(raw.tabs) ? raw.tabs.map(normalizeTab).filter((tab): tab is ProjectTabReference => Boolean(tab)) : [];
  const activeTabId = typeof raw.activeTabId === "string" && tabs.some((tab) => tab.id === raw.activeTabId)
    ? raw.activeTabId
    : undefined;
  return {
    version: typeof raw.version === "number" && raw.version > 0 ? Math.floor(raw.version) : 1,
    sqlDraft: string(raw.sqlDraft),
    tabs,
    activeTabId,
    history: normalizeHistory(raw.history),
    resultSequence: typeof raw.resultSequence === "number" && raw.resultSequence >= 0 ? Math.floor(raw.resultSequence) : 0,
  };
}

function normalizeSavedQuery(value: unknown, projectId: string): SavedQuery {
  const raw = object(value);
  return {
    projectId: string(raw.projectId, projectId),
    id: string(raw.id),
    name: string(raw.name, "Untitled query"),
    sql: string(raw.sql),
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : undefined,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : undefined,
  };
}

function normalizeJob(value: unknown, projectId = ""): Job {
  const raw = object(value);
  return {
    projectId: string(raw.projectId, projectId),
    id: string(raw.id),
    kind: string(raw.kind, "job"),
    label: typeof raw.label === "string" ? raw.label : undefined,
    state: (raw.state ?? "queued") as Job["state"],
    stage: typeof raw.stage === "string" ? raw.stage : undefined,
    message: typeof raw.message === "string" ? raw.message : undefined,
    progress: typeof raw.progress === "number" ? raw.progress : undefined,
    sourceId: typeof raw.sourceId === "string" ? raw.sourceId : undefined,
    sourceName: typeof raw.sourceName === "string" ? raw.sourceName : undefined,
    error: errorInfo(raw.error),
    createdAt: string(raw.createdAt),
    startedAt: typeof raw.startedAt === "string" ? raw.startedAt : undefined,
    finishedAt: typeof raw.finishedAt === "string" ? raw.finishedAt : undefined,
  };
}

function normalizeRelation(value: unknown): ExternalRelationInfo {
  const raw = object(value);
  return {
    ...(raw as unknown as ExternalRelationInfo),
    id: string(raw.id),
    connectionId: string(raw.connectionId),
    provider: raw.provider === "mongo" ? "mongo" : "postgres",
    catalog: string(raw.catalog),
    schema: string(raw.schema),
    name: string(raw.name),
    relationType: string(raw.relationType, "table"),
    qualifiedName: string(raw.qualifiedName),
    columns: Array.isArray(raw.columns) ? raw.columns as ExternalRelationInfo["columns"] : [],
    defaultOrder: Array.isArray(raw.defaultOrder) ? raw.defaultOrder as string[] : [],
    pagingStable: Boolean(raw.pagingStable),
  };
}

export function normalizeProjectWorkspace(value: ProjectWorkspace | RawObject): ProjectWorkspace {
  const raw = object(value);
  const project = normalizeProject(object(raw.project));
  const projectId = project.id;
  return {
    project,
    sources: normalizeSources(raw.sources, projectId),
    savedQueries: Array.isArray(raw.savedQueries) ? raw.savedQueries.map((query) => normalizeSavedQuery(query, projectId)) : [],
    connections: Array.isArray(raw.connections) ? raw.connections as ConnectionInfo[] : [],
    externalRelations: Array.isArray(raw.externalRelations) ? raw.externalRelations.map(normalizeRelation) : [],
    session: normalizeProjectSession(raw.session as ProjectSession | RawObject | undefined),
    warnings: Array.isArray(raw.warnings) ? raw.warnings.map(errorInfo).filter((warning): warning is AppErrorInfo => Boolean(warning)) : undefined,
  };
}

function normalizeImportResult(value: unknown, projectId: string): ImportPathsResult {
  const raw = object(value);
  const resolvedProjectId = string(raw.projectId, projectId);
  return {
    projectId: resolvedProjectId,
    paths: Array.isArray(raw.paths) ? raw.paths.filter((path): path is string => typeof path === "string") : undefined,
    sources: normalizePreviewSources(raw.sources, resolvedProjectId),
    jobs: Array.isArray(raw.jobs) ? raw.jobs.map((job) => normalizeJob(job, resolvedProjectId)) : [],
    workbooks: Array.isArray(raw.workbooks) ? raw.workbooks.map((workbook) => {
      const item = object(workbook);
      return {
        projectId: string(item.projectId, resolvedProjectId),
        path: string(item.path),
        displayName: typeof item.displayName === "string" ? item.displayName : undefined,
        sheets: Array.isArray(item.sheets) ? item.sheets.filter((sheet): sheet is string => typeof sheet === "string") : [],
      };
    }) : [],
  };
}

function normalizeEvent<K extends keyof BridgeEventMap>(eventName: K, value: unknown): BridgeEventMap[K] {
  const raw = object(value);
  if (eventName === "ducs:job-updated") return normalizeJob(raw) as BridgeEventMap[K];
  if (eventName === "ducs:connection-updated") return raw as BridgeEventMap[K];
  if (eventName === "ducs:file-drop") {
    const paths = Array.isArray(value) ? value : raw.paths;
    return {
      projectId: typeof raw.projectId === "string" ? raw.projectId : undefined,
      paths: Array.isArray(paths) ? paths.filter((path): path is string => typeof path === "string") : [],
    } as unknown as BridgeEventMap[K];
  }
  if (eventName === "ducs:catalog-invalidated") {
    return { projectId: string(raw.projectId), connectionId: string(raw.connectionId) } as BridgeEventMap[K];
  }
  if (eventName === "ducs:dataset-failed" || eventName === "ducs:snapshot-failed") {
    return {
      projectId: string(raw.projectId),
      sourceId: typeof raw.sourceId === "string" ? raw.sourceId : undefined,
      relationId: typeof raw.relationId === "string" ? raw.relationId : undefined,
      source: raw.source ? normalizeSource(object(raw.source), string(raw.projectId)) : undefined,
      error: errorInfo(raw.error) ?? { message: "The operation failed." },
    } as unknown as BridgeEventMap[K];
  }
  const sourceRaw = raw.source && typeof raw.source === "object" ? object(raw.source) : raw;
  const projectId = string(raw.projectId, string(sourceRaw.projectId));
  return { projectId, source: eventName === "ducs:dataset-preview" ? normalizePreviewSource(sourceRaw, projectId) : normalizeSource(sourceRaw, projectId) } as BridgeEventMap[K];
}

export const bridge = {
  async Bootstrap(): Promise<Bootstrap> {
    const raw = object(await app().Bootstrap());
    const workspace = raw.workspace && typeof raw.workspace === "object" ? normalizeProjectWorkspace(object(raw.workspace)) : undefined;
    return {
      projects: Array.isArray(raw.projects) ? raw.projects.map((project) => normalizeProject(object(project))) : workspace ? [workspace.project] : [],
      activeProjectId: typeof raw.activeProjectId === "string" ? raw.activeProjectId : workspace?.project.id,
      workspace,
      jobs: Array.isArray(raw.jobs) ? raw.jobs.map((job) => normalizeJob(job)) : [],
      ready: raw.ready !== false,
    };
  },

  OpenProject(projectId: string): Promise<ProjectWorkspace> {
    return app().OpenProject(projectId).then(normalizeProjectWorkspace);
  },
  CreateProject(request: { name: string; description: string }): Promise<Project> {
    return app().CreateProject(request).then(normalizeProject);
  },
  UpdateProject(request: { projectId: string; name: string; description: string }): Promise<Project> {
    return app().UpdateProject(request).then(normalizeProject);
  },
  ArchiveProject(projectId: string): Promise<Project> { return app().ArchiveProject(projectId).then(normalizeProject); },
  RestoreProject(projectId: string): Promise<Project> { return app().RestoreProject(projectId).then(normalizeProject); },
  SaveProjectSession(request: { projectId: string; session: ProjectSession }): Promise<void> {
    return app().SaveProjectSession({ ...request, session: normalizeProjectSession(request.session) });
  },

  ListGlobalConnections(): Promise<ConnectionInfo[]> { return app().ListGlobalConnections(); },
  AttachConnectionToProject(request: { projectId: string; connectionId: string }) { return app().AttachConnectionToProject(request); },
  DetachConnectionFromProject(request: { projectId: string; connectionId: string }): Promise<void> { return app().DetachConnectionFromProject(request); },
  async ConnectionUsageCount(connectionId: string): Promise<number> {
    const result = await app().ConnectionUsageCount(connectionId);
    return typeof result === "number" ? result : result.count;
  },

  async OpenFiles(projectId: string): Promise<ImportPathsResult | string[] | void> {
    const result = await app().OpenFiles(projectId);
    if (Array.isArray(result) || !result) return result;
    return normalizeImportResult(result, projectId);
  },
  async ImportPaths(request: ImportPathsRequest): Promise<ImportPathsResult> {
    return normalizeImportResult(await app().ImportPaths(request), request.projectId);
  },
  async ListWorkbookSheets(request: { projectId: string; path: string }): Promise<WorkbookSheets> {
    const result = await app().ListWorkbookSheets(request);
    if (Array.isArray(result)) return { ...request, sheets: result };
    return { ...result, projectId: result.projectId || request.projectId };
  },
  async StartXLSXImport(request: XLSXImportRequest): Promise<ImportStartResult> {
    const raw = object(await app().StartXLSXImport(request));
    const projectId = string(raw.projectId, request.projectId);
    return {
      projectId,
      sources: normalizePreviewSources(raw.sources, projectId),
      jobs: Array.isArray(raw.jobs) ? raw.jobs.map((job) => normalizeJob(job, projectId)) : [],
    };
  },
  async GetSource(request: { projectId: string; id: string }): Promise<SourceInfo> {
    return normalizeSource(await app().GetSource(request), request.projectId);
  },
  GetRows(request: RowsRequest) { return app().GetRows(request); },
  async GetCellValue(request: GetCellValueRequest): Promise<CellValueResult> {
    const result = await app().GetCellValue(request);
    return result && typeof result === "object" && "value" in result ? result as CellValueResult : { value: result };
  },
  async CountRows(request: CountRowsRequest): Promise<number | null> {
    const result = await app().CountRows(request);
    return typeof result === "number" ? result : result.count;
  },
  async RunQuery(request: QueryRequest): Promise<QueryResult> {
    const raw = object(await app().RunQuery(request));
    return {
      projectId: string(raw.projectId, request.projectId),
      source: normalizeSource(object(raw.source), request.projectId),
      columns: Array.isArray(raw.columns) ? raw.columns as QueryResult["columns"] : undefined,
      rowCount: typeof raw.rowCount === "number" ? raw.rowCount : undefined,
      durationMs: typeof raw.durationMs === "number" ? raw.durationMs : undefined,
      originalSQL: typeof (raw.originalSQL ?? raw.originalSql) === "string" ? String(raw.originalSQL ?? raw.originalSql) : undefined,
    };
  },
  async SaveQuery(request: SaveQueryRequest): Promise<SavedQuery> {
    return normalizeSavedQuery(await app().SaveQuery(request), request.projectId);
  },
  DeleteSavedQuery(request: { projectId: string; id: string }): Promise<void> { return app().DeleteSavedQuery(request); },
  async SaveResultAsTable(request: SaveResultAsTableRequest): Promise<SourceInfo> {
    return normalizeSource(await app().SaveResultAsTable(request), request.projectId);
  },
  CloseResult(request: { projectId: string; id: string }): Promise<void> { return app().CloseResult(request); },
  RemoveDataset(request: { projectId: string; id: string }): Promise<void> { return app().RemoveDataset(request); },
  ExportCSV(request: ExportRequest) { return app().ExportCSV(request); },

  CancelJob(jobId: string): Promise<Job> { return app().CancelJob(jobId).then((job) => normalizeJob(job)); },
  CreateConnection(request: ConnectionInput & { projectId: string }): Promise<ConnectionInfo> { return app().CreateConnection(request); },
  UpdateConnection(request: UpdateConnectionInput): Promise<ConnectionInfo> { return app().UpdateConnection(request); },
  DeleteConnection(id: string): Promise<void> { return app().DeleteConnection(id); },
  TestConnection(request: TestConnectionInput): Promise<void> { return app().TestConnection(request); },
  ConnectConnection(request: { projectId: string; id: string }): Promise<ConnectionInfo> { return app().ConnectConnection(request); },
  DisconnectConnection(request: { projectId: string; id: string }): Promise<void> { return app().DisconnectConnection(request); },
  RefreshConnectionCatalog(request: { projectId: string; id: string }): Promise<void> { return app().RefreshConnectionCatalog(request); },
  ListConnectionSchemas(request: { projectId: string; id: string }): Promise<{ name: string }[]> { return app().ListConnectionSchemas(request); },
  ListExternalRelations(request: { projectId: string; connectionId: string; schema: string }): Promise<ExternalRelationInfo[]> {
    return app().ListExternalRelations(request).then((relations) => relations.map(normalizeRelation));
  },
  GetExternalRelation(request: { projectId: string; id: string }): Promise<ExternalRelationInfo> {
    return app().GetExternalRelation(request).then(normalizeRelation);
  },
  SnapshotExternalRelation(request: { projectId: string; relationId: string; displayName?: string }): Promise<Job> {
    return app().SnapshotExternalRelation(request).then((job) => normalizeJob(job, request.projectId));
  },
  RefreshSnapshot(request: { projectId: string; sourceId: string }): Promise<Job> {
    return app().RefreshSnapshot(request).then((job) => normalizeJob(job, request.projectId));
  },

  on<K extends keyof BridgeEventMap>(eventName: K, callback: (payload: BridgeEventMap[K]) => void): () => void {
    const runtime = window.runtime;
    if (!runtime?.EventsOn) return () => undefined;
    const name = String(eventName);
    const handler = (payload: unknown) => callback(normalizeEvent(eventName, payload));
    const unsubscribe = runtime.EventsOn(name, handler);
    return typeof unsubscribe === "function" ? unsubscribe : () => runtime.EventsOff?.(name);
  },
};

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return errorInfo(error)?.message ?? "An unexpected error occurred.";
}

export function isBridgeAvailable(): boolean {
  return Boolean(window.go?.main?.App);
}
