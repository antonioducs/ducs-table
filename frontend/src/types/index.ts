export interface Project {
  id: string;
  name: string;
  description: string;
  archivedAt?: string;
  lastOpenedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectTabReference {
  id: string;
  kind: "local" | "external" | "placeholder";
  title: string;
  sourceId?: string;
  relationId?: string;
  connectionId?: string;
  catalog?: string;
  schema?: string;
  relation?: string;
  relationType?: string;
  isResult?: boolean;
  placeholderReason?: "disconnected" | "missing";
}

export interface QueryHistoryEntry {
  id: string;
  sql: string;
  ranAt: string;
  durationMs?: number;
  status: "success" | "error";
}

export interface ProjectSession {
  version: number;
  sqlDraft: string;
  tabs: ProjectTabReference[];
  activeTabId?: string;
  history: QueryHistoryEntry[];
  resultSequence: number;
}

export type SourceStatus = "preview" | "preparing" | "ready" | "failed" | "cancelled";

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
  projectId: string;
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
  /** Transient bridge payload only. The application store strips rows before storage. */
  previewRows?: DataRow[];
  error?: AppErrorInfo;
  originalSQL?: string;
  createdAt?: string;
  updatedAt?: string;
  snapshot?: SnapshotOrigin;
}

export interface SourcePreview {
  projectId: string;
  source: SourceInfo;
  rows?: DataRow[];
}

export interface PreviewSource extends SourceInfo {
  projectId: string;
  previewRows?: DataRow[];
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
  projectCount?: number;
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
  projectId: string;
  id: string;
  name: string;
  sql: string;
  createdAt?: string;
  updatedAt?: string;
}

export type JobState = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface Job {
  projectId: string;
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

export interface ProjectWorkspace {
  project: Project;
  sources: SourceInfo[];
  savedQueries: SavedQuery[];
  connections: ConnectionInfo[];
  externalRelations?: ExternalRelationInfo[];
  session: ProjectSession;
  warnings?: AppErrorInfo[];
}

export interface Bootstrap {
  projects: Project[];
  activeProjectId?: string;
  workspace?: ProjectWorkspace;
  jobs: Job[];
  ready?: boolean;
}

/** Kept as an alias for callers compiled against the first frontend contract. */
export type BootstrapState = Bootstrap;

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
  projectId: string;
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
  projectId: string;
  resource: GridResourceRef;
  sourceId?: string;
  filters?: RowFilter[];
}

export interface CountRowsResult { count: number | null }

export interface GetCellValueRequest {
  projectId: string;
  resource: GridResourceRef;
  sourceId?: string;
  rowIndex: number;
  column: string;
  sorts?: RowSort[];
  filters?: RowFilter[];
}

export interface CellValueResult { value: unknown }

export interface ImportOptions {
  delimiter?: string;
  header?: boolean;
  allVarchar?: boolean;
  ignoreErrors?: boolean;
}

export interface ImportPathsRequest {
  projectId: string;
  paths: string[];
  options?: ImportOptions;
}

export interface WorkbookSheets {
  projectId: string;
  path: string;
  displayName?: string;
  sheets: string[];
}

export interface ImportPathsResult {
  projectId: string;
  paths?: string[];
  sources?: PreviewSource[];
  jobs?: Job[];
  workbooks?: WorkbookSheets[];
}

export interface XLSXImportRequest {
  projectId: string;
  path: string;
  sheets: string[];
  options?: ImportOptions;
}

export interface ImportStartResult {
  projectId: string;
  sources: PreviewSource[];
  jobs: Job[];
}

export interface QueryRequest { projectId: string; sql: string }

export interface QueryResult {
  projectId: string;
  source: SourceInfo;
  columns?: ColumnInfo[];
  rowCount?: number;
  durationMs?: number;
  originalSQL?: string;
}

export interface SaveQueryRequest { projectId: string; id?: string; name: string; sql: string }
export interface SaveResultAsTableRequest { projectId: string; resultId: string; displayName: string }

export type ExportScope = "entire" | "current-view";

export interface ExportRequest {
  projectId: string;
  resource: GridResourceRef;
  sourceId?: string;
  destination?: string;
  scope: ExportScope;
  filters?: RowFilter[];
  sorts?: RowSort[];
  visibleColumns?: string[];
}

export interface ExportResult { path: string; size: number }

export interface ProjectSourceEvent { projectId: string; source: SourceInfo }
export interface ProjectPreviewEvent { projectId: string; source: PreviewSource }
export interface DatasetFailedEvent {
  projectId: string;
  sourceId: string;
  source?: SourceInfo;
  error: AppErrorInfo;
}
export interface SnapshotFailedEvent {
  projectId: string;
  sourceId?: string;
  relationId?: string;
  error: AppErrorInfo;
}
export interface FileDropEvent { projectId?: string; paths: string[] }

export type BridgeEventMap = {
  "ducs:job-updated": Job;
  "ducs:dataset-preview": ProjectPreviewEvent;
  "ducs:dataset-ready": ProjectSourceEvent;
  "ducs:dataset-failed": DatasetFailedEvent;
  "ducs:result-ready": ProjectSourceEvent;
  "ducs:file-drop": FileDropEvent;
  "ducs:connection-updated": ConnectionInfo;
  "ducs:catalog-invalidated": { projectId: string; connectionId: string };
  "ducs:snapshot-ready": ProjectSourceEvent;
  "ducs:snapshot-failed": SnapshotFailedEvent;
};
