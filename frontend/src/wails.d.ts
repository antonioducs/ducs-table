import type {
  Bootstrap,
  CellValueResult,
  ConnectionInfo,
  ConnectionInput,
  CountRowsRequest,
  CountRowsResult,
  ExportRequest,
  ExportResult,
  ExternalRelationInfo,
  GetCellValueRequest,
  ImportPathsRequest,
  ImportPathsResult,
  ImportStartResult,
  Job,
  Project,
  ProjectSession,
  ProjectWorkspace,
  QueryRequest,
  QueryResult,
  RowsRequest,
  RowsResponse,
  SavedQuery,
  SaveQueryRequest,
  SaveResultAsTableRequest,
  SourceInfo,
  TestConnectionInput,
  UpdateConnectionInput,
  WorkbookSheets,
  XLSXImportRequest,
  AIApprovalResponse,
  AIConfig,
  AIConversation,
  AIConversationDetail,
  AIConversationRequest,
  AICreateConversationRequest,
  AIModel,
  AIProviderStatus,
  AIRun,
  AISendRequest,
  AIStopRequest,
} from "@/types";

declare global {
  interface Window {
    go?: {
      main?: {
        App?: {
          Bootstrap(): Promise<Bootstrap>;
          OpenProject(projectId: string): Promise<ProjectWorkspace>;
          CreateProject(request: { name: string; description: string }): Promise<Project>;
          UpdateProject(request: { projectId: string; name: string; description: string }): Promise<Project>;
          ArchiveProject(projectId: string): Promise<Project>;
          RestoreProject(projectId: string): Promise<Project>;
          SaveProjectSession(request: { projectId: string; session: ProjectSession }): Promise<void>;

          ListGlobalConnections(): Promise<ConnectionInfo[]>;
          AttachConnectionToProject(request: { projectId: string; connectionId: string }): Promise<void | ConnectionInfo>;
          DetachConnectionFromProject(request: { projectId: string; connectionId: string }): Promise<void>;
          ConnectionUsageCount(connectionId: string): Promise<number | { count: number }>;

          OpenFiles(projectId: string): Promise<ImportPathsResult | string[] | void>;
          ImportPaths(request: ImportPathsRequest): Promise<ImportPathsResult>;
          ListWorkbookSheets(request: { projectId: string; path: string }): Promise<WorkbookSheets | string[]>;
          StartXLSXImport(request: XLSXImportRequest): Promise<ImportStartResult>;
          GetSource(request: { projectId: string; id: string }): Promise<SourceInfo>;
          GetRows(request: RowsRequest): Promise<RowsResponse>;
          GetCellValue(request: GetCellValueRequest): Promise<CellValueResult | unknown>;
          CountRows(request: CountRowsRequest): Promise<CountRowsResult | number>;
          RunQuery(request: QueryRequest): Promise<QueryResult>;
          SaveQuery(request: SaveQueryRequest): Promise<SavedQuery>;
          DeleteSavedQuery(request: { projectId: string; id: string }): Promise<void>;
          SaveResultAsTable(request: SaveResultAsTableRequest): Promise<SourceInfo>;
          CloseResult(request: { projectId: string; id: string }): Promise<void>;
          RemoveDataset(request: { projectId: string; id: string }): Promise<void>;
          ExportCSV(request: ExportRequest): Promise<ExportResult>;

          CancelJob(jobId: string): Promise<Job>;
          CreateConnection(request: ConnectionInput & { projectId: string }): Promise<ConnectionInfo>;
          UpdateConnection(request: UpdateConnectionInput): Promise<ConnectionInfo>;
          DeleteConnection(id: string): Promise<void>;
          TestConnection(request: TestConnectionInput): Promise<void>;
          ConnectConnection(request: { projectId: string; id: string }): Promise<ConnectionInfo>;
          DisconnectConnection(request: { projectId: string; id: string }): Promise<void>;
          RefreshConnectionCatalog(request: { projectId: string; id: string }): Promise<void>;
          ListConnectionSchemas(request: { projectId: string; id: string }): Promise<{ name: string }[]>;
          ListExternalRelations(request: { projectId: string; connectionId: string; schema: string }): Promise<ExternalRelationInfo[]>;
          GetExternalRelation(request: { projectId: string; id: string }): Promise<ExternalRelationInfo>;
          SnapshotExternalRelation(request: { projectId: string; relationId: string; displayName?: string; sqlName?: string }): Promise<Job>;
          RefreshSnapshot(request: { projectId: string; sourceId: string }): Promise<Job>;

          AIGetConfig(projectId: string): Promise<AIConfig>;
          AIProviderStatus(provider: string): Promise<AIProviderStatus>;
          AIProviderLogin(provider: string): Promise<unknown>;
          AIProviderLogout(provider: string): Promise<void>;
          AIProviderListModels(provider: string): Promise<AIModel[]>;
          AIListModels(provider: string): Promise<AIModel[]>;
          AIListConversations(projectId: string): Promise<AIConversation[]>;
          AICreateConversation(request: AICreateConversationRequest): Promise<AIConversation>;
          AIGetConversation(request: AIConversationRequest): Promise<AIConversationDetail>;
          AIDeleteConversation(request: AIConversationRequest): Promise<void>;
          AISend(request: AISendRequest): Promise<AIRun>;
          AIStop(request: AIStopRequest): Promise<AIRun>;
          AIRespondApproval(request: AIApprovalResponse): Promise<void>;
        };
      };
    };
    runtime?: {
      EventsOn?(eventName: string, callback: (payload: unknown) => void): (() => void) | void;
      EventsOff?(eventName: string): void;
      BrowserOpenURL?(url: string): void;
    };
    wails?: {
      Callback?(message: string): void;
      errorNormalizerInstalled?: boolean;
    };
  }
}

export {};
