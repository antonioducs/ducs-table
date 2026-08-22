import type {
  BootstrapState,
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
  QueryRequest,
  QueryResult,
  RowsRequest,
  TestConnectionInput,
  UpdateConnectionInput,
  SavedQuery,
  SaveQueryRequest,
  SaveResultAsTableRequest,
  SourceInfo,
  WorkbookSheets,
  XLSXImportRequest,
} from "@/types";
import { installWailsErrorNormalizer } from "@/lib/wails-error-normalizer";

type AppAPI = NonNullable<NonNullable<NonNullable<Window["go"]>["main"]>["App"]>;

const friendlyMissingMessage =
  "Duc's Table desktop bridge is unavailable. Run the app through Wails to use local files.";

function app(): AppAPI {
  installWailsErrorNormalizer();
  const api = window.go?.main?.App;
  if (!api) throw new Error(friendlyMissingMessage);
  return api;
}

function errorInfo(value: unknown): { message: string; code?: string; details?: Record<string, unknown> } | undefined {
  if (!value) return undefined;
  if (typeof value === "string") return { message: value };
  if (typeof value === "object") {
    const raw = value as Record<string, unknown>;
    return {
      message: typeof raw.message === "string" ? raw.message : "An unexpected local processing error occurred.",
      code: typeof raw.code === "string" ? raw.code : undefined,
      details: typeof raw.details === "object" && raw.details !== null
        ? (raw.details as Record<string, unknown>)
        : undefined,
    };
  }
  return { message: String(value) };
}

/** Keep legacy Go JSON names at the bridge boundary; components only see the UI contract. */
export function normalizeSource(value: SourceInfo | Record<string, unknown>): SourceInfo {
  const raw = value as unknown as Record<string, unknown>;
  const legacyCount = raw.rowCount;
  const inferredStatus = raw.status ?? (raw.error ? "failed" : "ready");
  return {
    id: String(raw.id ?? ""),
    displayName: String(raw.displayName ?? raw.name ?? "Untitled source"),
    tableName: String(raw.tableName ?? raw.sqlName ?? ""),
    sourcePath: typeof raw.sourcePath === "string" ? raw.sourcePath : undefined,
    kind: String(raw.kind ?? raw.sourceType ?? "table"),
    sheet: typeof raw.sheet === "string" && raw.sheet ? raw.sheet : undefined,
    size: typeof raw.size === "number" ? raw.size : undefined,
    rowCount: typeof legacyCount === "number" ? legacyCount : null,
    status: inferredStatus as SourceInfo["status"],
    isEphemeral: Boolean(raw.isEphemeral),
    columns: Array.isArray(raw.columns) ? (raw.columns as SourceInfo["columns"]) : [],
    previewRows: Array.isArray(raw.previewRows) ? (raw.previewRows as SourceInfo["previewRows"]) : undefined,
    error: errorInfo(raw.error),
    originalSQL: typeof (raw.originalSQL ?? raw.originalSql) === "string"
      ? String(raw.originalSQL ?? raw.originalSql)
      : undefined,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : undefined,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : undefined,
    snapshot: raw.snapshot && typeof raw.snapshot === "object" ? raw.snapshot as SourceInfo["snapshot"] : undefined,
  };
}

function normalizeSources(values: unknown): SourceInfo[] {
  return Array.isArray(values)
    ? values.filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object").map(normalizeSource)
    : [];
}

function normalizeImportResult(result: ImportPathsResult): ImportPathsResult {
  return { ...result, sources: normalizeSources(result.sources) };
}

function normalizeRelation(value: ExternalRelationInfo): ExternalRelationInfo {
  return { ...value, columns: Array.isArray(value.columns) ? value.columns : [], defaultOrder: Array.isArray(value.defaultOrder) ? value.defaultOrder : [], pagingStable: Boolean(value.pagingStable) };
}

export const bridge = {
  async Bootstrap(): Promise<BootstrapState> {
    const state = await app().Bootstrap();
    const raw = state as BootstrapState & { datasets?: SourceInfo[]; results?: SourceInfo[] };
    return {
      sources: normalizeSources(raw.sources ?? [...(raw.datasets ?? []), ...(raw.results ?? [])]),
      savedQueries: raw.savedQueries ?? [],
      jobs: raw.jobs ?? [],
      connections: raw.connections ?? [],
      ready: raw.ready ?? true,
    };
  },

  async OpenFiles(): Promise<ImportPathsResult | string[] | void> {
    const result = await app().OpenFiles();
    if (Array.isArray(result) || !result) return result;
    return normalizeImportResult(result);
  },

  async ImportPaths(request: ImportPathsRequest): Promise<ImportPathsResult> {
    return normalizeImportResult(await app().ImportPaths(request));
  },

  async ListWorkbookSheets(path: string): Promise<WorkbookSheets> {
    const result = await app().ListWorkbookSheets(path);
    return Array.isArray(result) ? { path, sheets: result } : result;
  },

  async StartXLSXImport(request: XLSXImportRequest): Promise<ImportStartResult> {
    const result = await app().StartXLSXImport(request);
    return { ...result, sources: normalizeSources(result.sources) };
  },

  async GetSource(sourceId: string): Promise<SourceInfo> {
    return normalizeSource(await app().GetSource(sourceId));
  },

  GetRows(request: RowsRequest) {
    return app().GetRows(request);
  },

  async GetCellValue(request: GetCellValueRequest): Promise<CellValueResult> {
    const result = await app().GetCellValue(request);
    if (result && typeof result === "object" && "value" in result) return result as CellValueResult;
    return { value: result };
  },

  async CountRows(request: CountRowsRequest): Promise<number | null> {
    const result = await app().CountRows(request);
    return typeof result === "number" ? result : result.count;
  },

  async RunQuery(request: QueryRequest): Promise<QueryResult> {
    const result = await app().RunQuery(request);
    return { ...result, source: normalizeSource(result.source) };
  },

  SaveQuery(request: SaveQueryRequest): Promise<SavedQuery> {
    return app().SaveQuery(request);
  },

  DeleteSavedQuery(queryId: string): Promise<void> {
    return app().DeleteSavedQuery(queryId);
  },

  async SaveResultAsTable(request: SaveResultAsTableRequest): Promise<SourceInfo> {
    return normalizeSource(await app().SaveResultAsTable(request));
  },

  CloseResult(resultId: string): Promise<void> {
    return app().CloseResult(resultId);
  },

  RemoveDataset(sourceId: string): Promise<void> {
    return app().RemoveDataset(sourceId);
  },

  ExportCSV(request: ExportRequest) {
    return app().ExportCSV(request);
  },

  CancelJob(jobId: string): Promise<Job> {
    return app().CancelJob(jobId);
  },

  ListConnections(): Promise<ConnectionInfo[]> { return app().ListConnections(); },
  CreateConnection(request: ConnectionInput): Promise<ConnectionInfo> { return app().CreateConnection(request); },
  UpdateConnection(request: UpdateConnectionInput): Promise<ConnectionInfo> { return app().UpdateConnection(request); },
  DeleteConnection(id: string): Promise<void> { return app().DeleteConnection(id); },
  TestConnection(request: TestConnectionInput): Promise<void> { return app().TestConnection(request); },
  ConnectConnection(id: string): Promise<ConnectionInfo> { return app().ConnectConnection({ id }); },
  DisconnectConnection(id: string): Promise<void> { return app().DisconnectConnection(id); },
  RefreshConnectionCatalog(id: string): Promise<void> { return app().RefreshConnectionCatalog(id); },
  ListConnectionSchemas(id: string): Promise<{ name: string }[]> { return app().ListConnectionSchemas(id); },
  ListExternalRelations(connectionId: string, schema: string): Promise<ExternalRelationInfo[]> {
    return app().ListExternalRelations({ connectionId, schema }).then((relations) => relations.map(normalizeRelation));
  },
  GetExternalRelation(id: string): Promise<ExternalRelationInfo> { return app().GetExternalRelation(id).then(normalizeRelation); },
  SnapshotExternalRelation(relationId: string, displayName?: string): Promise<Job> {
    return app().SnapshotExternalRelation({ relationId, displayName });
  },
  RefreshSnapshot(sourceId: string): Promise<Job> { return app().RefreshSnapshot({ sourceId }); },

  on<K extends keyof BridgeEventMap>(eventName: K, callback: (payload: BridgeEventMap[K]) => void): () => void {
    const runtime = window.runtime;
    if (!runtime?.EventsOn) return () => undefined;
    const name = String(eventName);
    const unsubscribe = runtime.EventsOn(name, callback as (payload: unknown) => void);
    return typeof unsubscribe === "function"
      ? unsubscribe
      : () => runtime.EventsOff?.(name);
  },
};

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  const info = errorInfo(error);
  return info?.message ?? "An unexpected error occurred.";
}

export function isBridgeAvailable(): boolean {
  return Boolean(window.go?.main?.App);
}
