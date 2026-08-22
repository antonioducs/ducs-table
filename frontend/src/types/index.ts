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
  sourceId: string;
  offset: number;
  limit: number;
  sorts?: RowSort[];
  filters?: RowFilter[];
  visibleColumns?: string[];
}

export interface RowsResponse {
  sourceId: string;
  columns: ColumnInfo[];
  rows: DataRow[];
  offset: number;
  limit: number;
  totalRows: number;
}

export interface CountRowsRequest {
  sourceId: string;
  filters?: RowFilter[];
}

export interface CountRowsResult {
  count: number;
}

export interface GetCellValueRequest {
  sourceId: string;
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
  sourceId: string;
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
};
