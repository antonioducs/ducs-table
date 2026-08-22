export type SourceStatus =
  | "preview"
  | "preparing"
  | "ready"
  | "failed"
  | "cancelled";

export type SourceKind =
  | "csv"
  | "tsv"
  | "json"
  | "jsonl"
  | "ndjson"
  | "xlsx"
  | "query"
  | "table"
  | string;

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  ordinal: number;
}

export type DataRow = Record<string, unknown>;

export interface SourceInfo {
  id: string;
  displayName: string;
  tableName: string;
  sourcePath?: string;
  kind: SourceKind;
  sheet?: string;
  size?: number;
  rowCount: number | null;
  status: SourceStatus;
  isEphemeral: boolean;
  columns: ColumnInfo[];
  previewRows?: DataRow[];
  error?: AppErrorInfo;
  originalSQL?: string;
  createdAt?: string;
  updatedAt?: string;
  snapshot?: SnapshotOrigin;
}

export interface SnapshotOrigin {
  connectionId?: string;
  connectionName: string;
  catalog: string;
  schema: string;
  relation: string;
  relationType: string;
  refreshedAt: string;
}

export type ConnectionKind = "postgres" | "mongo";
export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

export interface PostgresConfig {
  host: string;
  port: number;
  database: string;
  username: string;
  sslMode: "disable" | "allow" | "prefer" | "require" | "verify-ca" | "verify-full";
  schema?: string;
  connectTimeoutSeconds: number;
  poolSize: number;
}

export interface MongoConfig {
  mode: "mongodb" | "mongodb+srv";
  hosts: string[];
  database: string;
  username?: string;
  authSource?: string;
  tls: boolean;
  replicaSet?: string;
  directConnection?: boolean;
  readPreference?: "primary" | "primaryPreferred" | "secondary" | "secondaryPreferred" | "nearest";
  connectTimeoutSeconds: number;
  experimentalConsent: boolean;
}

export interface ConnectionConfig {
  postgres?: PostgresConfig;
  mongo?: MongoConfig;
}

export interface ConnectionInfo {
  id: string;
  name: string;
  kind: ConnectionKind;
  catalogName: string;
  config: ConnectionConfig;
  autoConnect: boolean;
  hasSecret: boolean;
  status: ConnectionStatus;
  lastError?: AppErrorInfo;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectionInput {
  name: string;
  kind: ConnectionKind;
  catalogName: string;
  config: ConnectionConfig;
  autoConnect: boolean;
  password?: string;
}

export interface UpdateConnectionInput extends Omit<ConnectionInput, "kind"> { id: string }
export interface TestConnectionInput { id?: string; kind?: ConnectionKind; config: ConnectionConfig; password?: string }

export interface ExternalRelationInfo {
  id: string;
  connectionId: string;
  provider: "postgres" | "mongo";
  catalog: string;
  schema: string;
  name: string;
  relationType: "table" | "view" | "collection" | string;
  qualifiedName: string;
  columns: ColumnInfo[];
  defaultOrder: string[];
  pagingStable: boolean;
}

export interface GridResourceRef {
  kind: "source" | "external";
  sourceId?: string;
  relationId?: string;
}

export interface AppErrorInfo {
  code?: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface SavedQuery {
  id: string;
  name: string;
  sql: string;
  createdAt?: string;
  updatedAt?: string;
}

export type JobState =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface Job {
  id: string;
  kind: string;
  label?: string;
  state: JobState;
  stage?: string;
  message?: string;
  progress?: number;
  sourceId?: string;
  sourceName?: string;
  error?: AppErrorInfo;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface BootstrapState {
  sources: SourceInfo[];
  connections: ConnectionInfo[];
  savedQueries: SavedQuery[];
  jobs: Job[];
  ready?: boolean;
}

export type SortDirection = "asc" | "desc";

export interface RowSort {
  column: string;
  direction: SortDirection;
}

export type FilterOperator =
  | "equals"
  | "notEqual"
  | "contains"
  | "notContains"
  | "startsWith"
  | "endsWith"
  | "lessThan"
  | "lessThanOrEqual"
  | "greaterThan"
  | "greaterThanOrEqual"
  | "inRange"
  | "blank"
  | "notBlank";

export interface RowFilter {
  column: string;
  type: "text" | "number" | "date" | "boolean";
  operator: FilterOperator;
  value?: string | number | boolean | null;
  valueTo?: string | number | null;
}

export interface RowsRequest {
  resource: GridResourceRef;
  sourceId?: string;
  offset: number;
  limit: number;
  sorts?: RowSort[];
  filters?: RowFilter[];
  visibleColumns?: string[];
}

export interface RowsResponse {
  resource: GridResourceRef;
  sourceId?: string;
  columns: ColumnInfo[];
  rows: DataRow[];
  offset: number;
  limit: number;
  totalRows: number | null;
  hasMore: boolean;
  pagingStable: boolean;
}

export interface CountRowsRequest {
  resource: GridResourceRef;
  sourceId?: string;
  filters?: RowFilter[];
}

export interface CountRowsResult {
  count: number | null;
}

export interface GetCellValueRequest {
  resource: GridResourceRef;
  sourceId?: string;
  rowIndex: number;
  column: string;
  sorts?: RowSort[];
  filters?: RowFilter[];
}

export interface CellValueResult {
  value: unknown;
}

export interface ImportOptions {
  delimiter?: string;
  header?: boolean;
  allVarchar?: boolean;
  ignoreErrors?: boolean;
}

export interface ImportPathsRequest {
  paths: string[];
  options?: ImportOptions;
}

export interface WorkbookSheets {
  path: string;
  displayName?: string;
  sheets: string[];
}

export interface ImportPathsResult {
  paths?: string[];
  sources?: SourceInfo[];
  jobs?: Job[];
  workbooks?: WorkbookSheets[];
}

export interface XLSXImportRequest {
  path: string;
  sheets: string[];
  options?: ImportOptions;
}

export interface ImportStartResult {
  sources: SourceInfo[];
  jobs: Job[];
}

export interface QueryRequest {
  sql: string;
}

export interface QueryResult {
  source: SourceInfo;
  columns?: ColumnInfo[];
  rowCount?: number;
  durationMs?: number;
  originalSQL?: string;
}

export interface SaveQueryRequest {
  id?: string;
  name: string;
  sql: string;
}

export interface SaveResultAsTableRequest {
  resultId: string;
  displayName: string;
}

export type ExportScope = "entire" | "current-view";

export interface ExportRequest {
  resource: GridResourceRef;
  sourceId?: string;
  destination?: string;
  scope: ExportScope;
  filters?: RowFilter[];
  sorts?: RowSort[];
  visibleColumns?: string[];
}

export interface ExportResult {
  path: string;
  size: number;
}

export interface DatasetFailedEvent {
  sourceId: string;
  source?: SourceInfo;
  error: AppErrorInfo;
}

export interface FileDropEvent {
  paths: string[];
}

export type BridgeEventMap = {
  "ducs:job-updated": Job;
  "ducs:dataset-preview": SourceInfo | { source: SourceInfo };
  "ducs:dataset-ready": SourceInfo | { source: SourceInfo };
  "ducs:dataset-failed": DatasetFailedEvent;
  "ducs:result-ready": QueryResult | SourceInfo;
  "ducs:file-drop": FileDropEvent | string[];
  "ducs:connection-updated": ConnectionInfo;
  "ducs:catalog-invalidated": { connectionId: string };
  "ducs:snapshot-ready": SourceInfo;
  "ducs:snapshot-failed": { sourceId?: string; relationId?: string; error: AppErrorInfo };
};
