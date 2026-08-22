import type {
  BootstrapState,
  CellValueResult,
  CountRowsRequest,
  CountRowsResult,
  ExportRequest,
  ExportResult,
  GetCellValueRequest,
  ImportPathsRequest,
  ImportPathsResult,
  ImportStartResult,
  Job,
  QueryRequest,
  QueryResult,
  RowsRequest,
  RowsResponse,
  SavedQuery,
  SaveQueryRequest,
  SaveResultAsTableRequest,
  SourceInfo,
  WorkbookSheets,
  XLSXImportRequest,
} from "@/types";

declare global {
  interface Window {
    go?: {
      main?: {
        App?: {
          Bootstrap(): Promise<BootstrapState>;
          OpenFiles(): Promise<ImportPathsResult | string[] | void>;
          ImportPaths(request: ImportPathsRequest): Promise<ImportPathsResult>;
          ListWorkbookSheets(path: string): Promise<WorkbookSheets | string[]>;
          StartXLSXImport(request: XLSXImportRequest): Promise<ImportStartResult>;
          GetSource(sourceId: string): Promise<SourceInfo>;
          GetRows(request: RowsRequest): Promise<RowsResponse>;
          GetCellValue(request: GetCellValueRequest): Promise<CellValueResult | unknown>;
          CountRows(request: CountRowsRequest): Promise<CountRowsResult | number>;
          RunQuery(request: QueryRequest): Promise<QueryResult>;
          SaveQuery(request: SaveQueryRequest): Promise<SavedQuery>;
          DeleteSavedQuery(queryId: string): Promise<void>;
          SaveResultAsTable(request: SaveResultAsTableRequest): Promise<SourceInfo>;
          CloseResult(resultId: string): Promise<void>;
          RemoveDataset(sourceId: string): Promise<void>;
          ExportCSV(request: ExportRequest): Promise<ExportResult>;
          CancelJob(jobId: string): Promise<Job>;
        };
      };
    };
    runtime?: {
      EventsOn?(eventName: string, callback: (payload: unknown) => void): (() => void) | void;
      EventsOff?(eventName: string): void;
    };
  }
}

export {};
