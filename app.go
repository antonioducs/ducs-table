package main

import (
	"context"
	"log/slog"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"ducs-table/internal/ai"
	"ducs-table/internal/applog"
	"ducs-table/internal/apppaths"
	"ducs-table/internal/connections"
	"ducs-table/internal/credentials"
	"ducs-table/internal/database"
	exportservice "ducs-table/internal/export"
	"ducs-table/internal/extensions"
	"ducs-table/internal/federation"
	"ducs-table/internal/grid"
	"ducs-table/internal/importers"
	"ducs-table/internal/jobs"
	"ducs-table/internal/models"
	"ducs-table/internal/query"
	"ducs-table/internal/workspace"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// App is the deliberately small Wails surface. The frontend receives metadata
// and row blocks only; file parsing, SQL, and exports stay in Go/DuckDB.
type App struct {
	ctx         context.Context
	cancel      context.CancelFunc
	db          *database.DB
	workspace   *workspace.Service
	imports     *importers.Service
	grid        *grid.Service
	queries     *query.Service
	exports     *exportservice.Service
	jobs        *jobs.Manager
	extensions  *extensions.Manager
	federated   *federation.Session
	connections *connections.Service
	ai          *ai.Service
	logger      *applog.Logger
	startupErr  error
	closeOnce   sync.Once
	autoConnect sync.Mutex
}

func NewApp() *App { return &App{} }

func (a *App) startup(ctx context.Context) {
	a.ctx, a.cancel = context.WithCancel(ctx)
	paths, err := apppaths.Default()
	if err != nil {
		a.startupErr = err
		return
	}
	appLogger, err := applog.Open(paths.LogPath, applog.Options{})
	if err != nil {
		a.startupErr = models.WrapError(models.CodeIO, "The application log could not be opened", err, nil)
		return
	}
	a.logger = appLogger
	slog.SetDefault(appLogger.Slog())
	a.logger.Info("application_started", "log_path", paths.LogPath)
	db, err := database.Open(a.ctx, paths)
	if err != nil {
		a.logger.Error("workspace_open_failed", err, []string{paths.DBPath}, "database", filepath.Base(paths.DBPath))
		a.startupErr = workspaceOpenError(err)
		return
	}
	a.db = db
	a.jobs = jobs.NewManagerWithContext(a.ctx, 2, func(snapshot jobs.Snapshot) {
		if snapshot.Kind == "import" && snapshot.State == jobs.StateCancelled && snapshot.StartedAt == nil {
			a.logQueuedImportCancelled(snapshot)
		}
		a.emit("ducs:job-updated", snapshot)
	})
	a.extensions = extensions.NewManager()
	federated, err := federation.New(a.ctx, db)
	if err != nil {
		a.startupErr = err
		_ = db.Close()
		return
	}
	a.federated = federated
	a.workspace = workspace.New(db)
	a.connections = connections.NewService(db, federated, credentials.New(), a.extensions, a.workspace, func(info connections.ConnectionInfo) {
		a.emit("ducs:connection-updated", info)
	})
	a.imports = importers.New(db, a.extensions)
	a.grid = grid.New(db, a.workspace)
	a.grid.SetExternalResolver(a.connections)
	a.queries = query.New(db, federated)
	a.exports = exportservice.New(db, a.grid)
	approvals := ai.NewApprovalManager(func(request ai.ApprovalRequest) {
		a.emit("ducs:ai-approval-request", request)
	})
	aiTools := ai.NewTools(a.workspace, a.connections, ai.NewDuckDBPreviewer(db, federated), approvals)
	aiRuntime := ai.NewService(a.ctx, ai.NewRepository(db), nil, aiTools, approvals, filepath.Join(paths.BaseDir, "ai", "runtime"), a.emit)
	supervisor := ai.NewSupervisor(a.ctx, ai.ExecStarter{
		DataDir: filepath.Join(paths.BaseDir, "ai", "providers"),
	}, aiRuntime.HandleRequest, aiRuntime.HandleNotification)
	aiRuntime.SetClient(supervisor)
	a.ai = aiRuntime
	runtime.OnFileDrop(a.ctx, func(_, _ int, paths []string) {
		// WebKit/Wails can report an HTML draggable element as a native file
		// drop with one empty path. Only absolute, non-empty filesystem paths
		// are valid here; filtering them prevents workbench tab drags from
		// accidentally starting a failed import.
		if paths = droppedFilePaths(paths); len(paths) > 0 {
			a.emit("ducs:file-drop", map[string]any{"paths": paths})
		}
	})
}

func droppedFilePaths(paths []string) []string {
	result := make([]string, 0, len(paths))
	seen := make(map[string]struct{}, len(paths))
	for _, path := range paths {
		if strings.TrimSpace(path) == "" {
			continue
		}
		path = filepath.Clean(path)
		if !filepath.IsAbs(path) {
			continue
		}
		if _, exists := seen[path]; exists {
			continue
		}
		seen[path] = struct{}{}
		result = append(result, path)
	}
	return result
}

func (a *App) shutdown(context.Context) {
	a.closeOnce.Do(func() {
		if a.ctx != nil {
			runtime.OnFileDropOff(a.ctx)
		}
		if a.ai != nil {
			_ = a.ai.Close()
		}
		if a.cancel != nil {
			a.cancel()
		}
		if a.jobs != nil {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			_ = a.jobs.Shutdown(ctx)
			cancel()
		}
		if a.connections != nil {
			_ = a.connections.Shutdown()
		}
		if a.db != nil {
			_ = a.db.Close()
		}
		if a.logger != nil {
			a.logger.Info("application_stopped")
			_ = a.logger.Close()
		}
	})
}

func (a *App) AIGetConfig(projectID string) (ai.Config, error) {
	if err := a.ready(); err != nil {
		return ai.Config{}, err
	}
	if err := a.validateProject(projectID); err != nil {
		return ai.Config{}, err
	}
	return a.ai.GetConfig(a.ctx, projectID)
}

func (a *App) AIProviderStatus(provider string) (ai.ProviderStatus, error) {
	if err := a.ready(); err != nil {
		return ai.ProviderStatus{}, err
	}
	return a.ai.ProviderStatus(a.ctx, ai.Provider(provider), true)
}

func (a *App) AIProviderLogin(provider string) (any, error) {
	if err := a.ready(); err != nil {
		return nil, err
	}
	return a.ai.ProviderLogin(a.ctx, ai.Provider(provider))
}

func (a *App) AIProviderLogout(provider string) error {
	if err := a.ready(); err != nil {
		return err
	}
	return a.ai.ProviderLogout(a.ctx, ai.Provider(provider))
}

func (a *App) AIProviderListModels(provider string) ([]ai.Model, error) {
	if err := a.ready(); err != nil {
		return nil, err
	}
	return a.ai.ListModels(a.ctx, ai.Provider(provider))
}

// AIListModels is the stable provider-neutral bridge name. The older
// AIProviderListModels alias remains for generated bindings from early builds.
func (a *App) AIListModels(provider string) ([]ai.Model, error) {
	return a.AIProviderListModels(provider)
}

func (a *App) AIListConversations(projectID string) ([]ai.Conversation, error) {
	if err := a.ready(); err != nil {
		return nil, err
	}
	if err := a.validateProject(projectID); err != nil {
		return nil, err
	}
	return a.ai.ListConversations(a.ctx, projectID)
}

func (a *App) AICreateConversation(request ai.CreateConversationRequest) (ai.Conversation, error) {
	if err := a.ready(); err != nil {
		return ai.Conversation{}, err
	}
	if err := a.validateProject(request.ProjectID); err != nil {
		return ai.Conversation{}, err
	}
	return a.ai.CreateConversation(a.ctx, request)
}

func (a *App) AIGetConversation(request ai.ConversationRequest) (ai.ConversationDetail, error) {
	if err := a.ready(); err != nil {
		return ai.ConversationDetail{}, err
	}
	if err := a.validateProject(request.ProjectID); err != nil {
		return ai.ConversationDetail{}, err
	}
	return a.ai.GetConversation(a.ctx, request)
}

func (a *App) AIDeleteConversation(request ai.ConversationRequest) error {
	if err := a.ready(); err != nil {
		return err
	}
	if err := a.validateProject(request.ProjectID); err != nil {
		return err
	}
	return a.ai.DeleteConversation(a.ctx, request)
}

func (a *App) AISend(request ai.SendRequest) (ai.Run, error) {
	if err := a.ready(); err != nil {
		return ai.Run{}, err
	}
	if err := a.validateProject(request.ProjectID); err != nil {
		return ai.Run{}, err
	}
	return a.ai.Send(a.ctx, request)
}

func (a *App) AIStop(request ai.StopRequest) (ai.Run, error) {
	if err := a.ready(); err != nil {
		return ai.Run{}, err
	}
	return a.ai.Stop(a.ctx, request)
}

func (a *App) AIRespondApproval(request ai.ApprovalResponse) error {
	if err := a.ready(); err != nil {
		return err
	}
	return a.ai.RespondApproval(request)
}

func (a *App) ready() error {
	if a.startupErr != nil {
		if appErr, ok := a.startupErr.(*models.AppError); ok {
			return appErr
		}
		return models.WrapError(models.CodeDatabase, "The local workspace could not be opened", a.startupErr, nil)
	}
	if a.db == nil || a.workspace == nil {
		return models.NewError(models.CodeShuttingDown, "The local workspace is not ready", nil)
	}
	if err := a.ctx.Err(); err != nil {
		return models.WrapError(models.CodeShuttingDown, "The application is shutting down", err, nil)
	}
	return nil
}

func workspaceOpenError(err error) error {
	if err == nil {
		return nil
	}
	message := strings.ToLower(err.Error())
	if strings.Contains(message, "lock") || strings.Contains(message, "another process") || strings.Contains(message, "conflicting") {
		return models.WrapError(
			models.CodeConflict,
			"Duc's Table is already open. Use the existing window and close any older instance before trying again",
			err,
			nil,
		)
	}
	return err
}

func (a *App) validateProject(projectID string) error {
	project, err := a.workspace.GetProject(a.ctx, projectID)
	if err != nil {
		return err
	}
	if project.ArchivedAt != nil {
		return models.NewError(models.CodeProjectArchived, "Project is archived", map[string]any{"projectId": projectID})
	}
	return nil
}

func (a *App) emit(name string, payload any) {
	if a.ctx != nil && a.ctx.Err() == nil {
		defer func() { _ = recover() }()
		runtime.EventsEmit(a.ctx, name, payload)
	}
}

func (a *App) Bootstrap() (BootstrapState, error) {
	if err := a.ready(); err != nil {
		return BootstrapState{}, err
	}
	projects, err := a.workspace.ListProjects(a.ctx, true)
	if err != nil {
		return BootstrapState{}, err
	}
	initial, err := a.workspace.InitialProject(a.ctx)
	if err != nil {
		return BootstrapState{}, err
	}
	if _, err := a.workspace.OpenProject(a.ctx, initial.ID); err != nil {
		return BootstrapState{}, err
	}
	workspaceState, err := a.loadProjectWorkspace(initial.ID)
	if err != nil {
		return BootstrapState{}, err
	}
	for i := range projects {
		if projects[i].ID == workspaceState.Project.ID {
			projects[i] = workspaceState.Project
			break
		}
	}
	result := BootstrapState{
		Projects: projects, ActiveProjectID: initial.ID, Workspace: workspaceState,
		Jobs: a.jobs.List(), Ready: true,
	}
	a.scheduleAutoConnect(initial.ID, workspaceState.Connections)
	return result, nil
}

func (a *App) loadProjectWorkspace(projectID string) (ProjectWorkspace, error) {
	state, err := a.workspace.Bootstrap(a.ctx, projectID)
	if err != nil {
		return ProjectWorkspace{}, err
	}
	connectionList, err := a.connections.ListProjectConnections(a.ctx, projectID)
	if err != nil {
		return ProjectWorkspace{}, err
	}
	externalRelations := make([]models.ExternalRelationInfo, 0)
	warnings := make([]*models.AppError, 0)
	keptTabs := make([]models.ProjectTabReference, 0, len(state.Session.Tabs))
	sessionChanged := false
	for _, tab := range state.Session.Tabs {
		if tab.Kind != models.ProjectTabKindExternal && !(tab.Kind == models.ProjectTabKindPlaceholder && tab.ConnectionID != "") {
			keptTabs = append(keptTabs, tab)
			continue
		}
		relation, restoreErr := a.connections.RestoreExternalRelation(a.ctx, projectID, tab)
		if restoreErr != nil {
			warning := models.AsAppError(restoreErr)
			switch warning.Code {
			case models.CodeExternalRelationNotFound, models.CodeConnectionNotFound:
				sessionChanged = true
				warnings = append(warnings, models.NewError(warning.Code, "A saved external tab was removed because its relation is no longer available", map[string]any{"tabId": tab.ID, "projectId": projectID}))
				continue
			case models.CodeCatalogLoadFailed, models.CodeConnectionFailed, models.CodeConnectionNotConnected:
				tab.Kind = models.ProjectTabKindPlaceholder
				tab.PlaceholderReason = "disconnected"
				if relation.ID != "" {
					tab.RelationID = relation.ID
					externalRelations = append(externalRelations, relation)
				}
				keptTabs = append(keptTabs, tab)
				sessionChanged = true
				warnings = append(warnings, models.NewError(warning.Code, "A saved external tab could not be validated yet and remains available as a placeholder", map[string]any{"tabId": tab.ID, "projectId": projectID}))
				continue
			default:
				return ProjectWorkspace{}, restoreErr
			}
		}
		if tab.RelationID != relation.ID {
			tab.RelationID = relation.ID
			sessionChanged = true
		}
		connected := false
		for _, info := range connectionList {
			if info.ID == tab.ConnectionID && info.Status == connections.StatusConnected {
				connected = true
				break
			}
		}
		if connected && tab.Kind == models.ProjectTabKindPlaceholder {
			tab.Kind = models.ProjectTabKindExternal
			tab.PlaceholderReason = ""
			sessionChanged = true
		} else if !connected && tab.Kind == models.ProjectTabKindExternal {
			tab.Kind = models.ProjectTabKindPlaceholder
			tab.PlaceholderReason = "disconnected"
			sessionChanged = true
		}
		keptTabs = append(keptTabs, tab)
		externalRelations = append(externalRelations, relation)
	}
	if sessionChanged {
		state.Session.Tabs = keptTabs
		workspace.NormalizeSession(&state.Session)
		if err := a.workspace.SaveSession(a.ctx, projectID, state.Session); err != nil {
			return ProjectWorkspace{}, err
		}
	}
	return ProjectWorkspace{
		Project: state.Project, Sources: state.Sources, SavedQueries: state.SavedQueries,
		Connections: connectionList, ExternalRelations: externalRelations, Session: state.Session, Warnings: warnings,
	}, nil
}

func (a *App) scheduleAutoConnect(projectID string, items []connections.ConnectionInfo) {
	items = append([]connections.ConnectionInfo(nil), items...)
	go func() {
		select {
		case <-a.ctx.Done():
			return
		case <-time.After(100 * time.Millisecond):
		}
		for _, info := range items {
			if !info.AutoConnect || info.Status == connections.StatusConnected || info.Status == connections.StatusConnecting {
				continue
			}
			connectionID := info.ID
			a.autoConnect.Lock()
			alreadyScheduled := false
			for _, existing := range a.jobs.List() {
				if existing.Kind == "connection" && existing.SourceID == connectionID &&
					(existing.State == jobs.StateQueued || existing.State == jobs.StateRunning) {
					alreadyScheduled = true
					break
				}
			}
			if alreadyScheduled {
				a.autoConnect.Unlock()
				continue
			}
			current, err := a.connections.GetConnection(a.ctx, connectionID)
			if err != nil || current.Status == connections.StatusConnected || current.Status == connections.StatusConnecting {
				a.autoConnect.Unlock()
				continue
			}
			_, submitErr := a.jobs.Submit(jobs.Metadata{ProjectID: projectID, Kind: "connection", Label: "Connect " + info.Name, SourceID: connectionID}, func(ctx context.Context, reporter jobs.Reporter) (any, error) {
				reporter.Update(0, "Connecting external database…")
				connected, connectErr := a.connections.Connect(ctx, projectID, connectionID)
				if connectErr == nil {
					reporter.Update(1, "Connected")
				}
				return connected, connectErr
			})
			a.autoConnect.Unlock()
			if submitErr != nil {
				return
			}
		}
	}()
}

func (a *App) OpenProject(projectID string) (ProjectWorkspace, error) {
	if err := a.ready(); err != nil {
		return ProjectWorkspace{}, err
	}
	if _, err := a.workspace.OpenProject(a.ctx, projectID); err != nil {
		return ProjectWorkspace{}, err
	}
	state, err := a.loadProjectWorkspace(projectID)
	if err != nil {
		return ProjectWorkspace{}, err
	}
	a.scheduleAutoConnect(projectID, state.Connections)
	return state, nil
}

func (a *App) CreateProject(request ProjectCreateRequest) (models.Project, error) {
	if err := a.ready(); err != nil {
		return models.Project{}, err
	}
	return a.workspace.CreateProject(a.ctx, request.Name, request.Description)
}

func (a *App) UpdateProject(request ProjectUpdateRequest) (models.Project, error) {
	if err := a.ready(); err != nil {
		return models.Project{}, err
	}
	return a.workspace.UpdateProject(a.ctx, request.ProjectID, request.Name, request.Description)
}

func (a *App) ArchiveProject(projectID string) (models.Project, error) {
	if err := a.ready(); err != nil {
		return models.Project{}, err
	}
	if a.jobs.HasActiveProject(projectID) {
		return models.Project{}, models.NewError(models.CodeConflict, "A project with queued or running jobs cannot be archived", map[string]any{"projectId": projectID})
	}
	return a.workspace.ArchiveProject(a.ctx, projectID)
}

func (a *App) RestoreProject(projectID string) (models.Project, error) {
	if err := a.ready(); err != nil {
		return models.Project{}, err
	}
	return a.workspace.RestoreProject(a.ctx, projectID)
}

func (a *App) SaveProjectSession(request ProjectSessionRequest) error {
	if err := a.ready(); err != nil {
		return err
	}
	return a.workspace.SaveSession(a.ctx, request.ProjectID, request.Session)
}

func (a *App) OpenFiles(projectID string) (ImportPathsResult, error) {
	if err := a.ready(); err != nil {
		return ImportPathsResult{}, err
	}
	if err := a.validateProject(projectID); err != nil {
		return ImportPathsResult{}, err
	}
	paths, err := runtime.OpenMultipleFilesDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "Open data files",
		Filters: []runtime.FileFilter{{
			DisplayName: "Data files (*.csv, *.tsv, *.json, *.jsonl, *.ndjson, *.xlsx)",
			Pattern:     "*.csv;*.tsv;*.json;*.jsonl;*.ndjson;*.xlsx",
		}},
		ResolvesAliases: true,
	})
	if err != nil {
		return ImportPathsResult{}, models.WrapError(models.CodeIO, "The file picker could not be opened", err, nil)
	}
	if len(paths) == 0 {
		return ImportPathsResult{}, nil
	}
	return a.ImportPaths(ImportPathsRequest{ProjectID: projectID, Paths: paths})
}

func (a *App) ImportPaths(request ImportPathsRequest) (ImportPathsResult, error) {
	if err := a.ready(); err != nil {
		return ImportPathsResult{}, err
	}
	if err := a.validateProject(request.ProjectID); err != nil {
		return ImportPathsResult{}, err
	}
	result := ImportPathsResult{
		ProjectID: request.ProjectID,
		Sources:   make([]PreviewSource, 0, len(request.Paths)),
		Jobs:      make([]jobs.Snapshot, 0, len(request.Paths)),
	}
	for _, path := range request.Paths {
		file, err := a.imports.Validate(path)
		if err != nil {
			failed, idErr := failedPreview(request.ProjectID, path, "", err)
			if idErr != nil {
				return result, idErr
			}
			diagnostic := newImportDiagnostic(request.ProjectID, failed.ID, path, stringFromExtension(path), time.Now())
			a.logImportStarted(diagnostic)
			failed.Error = a.recordImportFailure(err, diagnostic)
			result.Sources = append(result.Sources, failed)
			continue
		}
		if file.Type == importers.FileXLSX {
			sheets, sheetErr := a.imports.ListSheets(file.Path)
			if sheetErr != nil {
				failed, idErr := failedPreview(request.ProjectID, file.Path, string(file.Type), sheetErr)
				if idErr != nil {
					return result, idErr
				}
				diagnostic := newImportDiagnostic(request.ProjectID, failed.ID, file.Path, string(file.Type), time.Now())
				a.logImportStarted(diagnostic)
				failed.Error = a.recordImportFailure(sheetErr, diagnostic)
				result.Sources = append(result.Sources, failed)
				continue
			}
			if len(sheets) > 1 {
				result.Workbooks = append(result.Workbooks, WorkbookSheets{
					ProjectID: request.ProjectID, Path: file.Path, DisplayName: file.Name, Sheets: sheets,
				})
				continue
			}
			preview, job, startErr := a.startImport(request.ProjectID, file.Path, sheets[0], request.Options)
			if startErr != nil {
				return result, startErr
			}
			result.Sources = append(result.Sources, preview)
			if job != nil {
				result.Jobs = append(result.Jobs, *job)
			}
			continue
		}
		preview, job, startErr := a.startImport(request.ProjectID, file.Path, "", request.Options)
		if startErr != nil {
			return result, startErr
		}
		result.Sources = append(result.Sources, preview)
		if job != nil {
			result.Jobs = append(result.Jobs, *job)
		}
	}
	return result, nil
}

func (a *App) ListWorkbookSheets(request WorkbookSheetsRequest) (WorkbookSheets, error) {
	if err := a.ready(); err != nil {
		return WorkbookSheets{}, err
	}
	if err := a.validateProject(request.ProjectID); err != nil {
		return WorkbookSheets{}, err
	}
	file, err := a.imports.Validate(request.Path)
	if err != nil {
		return WorkbookSheets{}, err
	}
	sheets, err := a.imports.ListSheets(file.Path)
	if err != nil {
		return WorkbookSheets{}, err
	}
	return WorkbookSheets{ProjectID: request.ProjectID, Path: file.Path, DisplayName: file.Name, Sheets: sheets}, nil
}

func (a *App) StartXLSXImport(request XLSXImportRequest) (ImportPathsResult, error) {
	if err := a.ready(); err != nil {
		return ImportPathsResult{}, err
	}
	if err := a.validateProject(request.ProjectID); err != nil {
		return ImportPathsResult{}, err
	}
	if len(request.Sheets) == 0 {
		return ImportPathsResult{}, models.NewError(models.CodeInvalidArgument, "Choose a worksheet to import", nil)
	}
	result := ImportPathsResult{ProjectID: request.ProjectID, Sources: make([]PreviewSource, 0, len(request.Sheets)), Jobs: make([]jobs.Snapshot, 0, len(request.Sheets))}
	for _, sheet := range request.Sheets {
		preview, job, err := a.startImport(request.ProjectID, request.Path, sheet, request.Options)
		if err != nil {
			return result, err
		}
		result.Sources = append(result.Sources, preview)
		if job != nil {
			result.Jobs = append(result.Jobs, *job)
		}
	}
	return result, nil
}

func (a *App) startImport(projectID, path, sheet string, options importers.Options) (PreviewSource, *jobs.Snapshot, error) {
	id, err := models.NewID()
	if err != nil {
		return PreviewSource{}, nil, models.WrapError(models.CodeDatabase, "Could not create an import ID", err, nil)
	}
	diagnostic := newImportDiagnostic(projectID, id, path, stringFromExtension(path), time.Now())
	a.logImportStarted(diagnostic)
	preview, err := a.imports.Preview(a.ctx, path, options, sheet, 200)
	if err != nil {
		diagnosed := a.recordImportFailure(err, diagnostic)
		failed, failedErr := failedPreviewWithID(projectID, id, path, stringFromExtension(path), diagnosed)
		return failed, nil, failedErr
	}
	diagnostic.SourceType = string(preview.File.Type)
	diagnostic.Size = preview.File.Size
	displayName := strings.TrimSuffix(preview.File.Name, filepath.Ext(preview.File.Name))
	if preview.Sheet != "" {
		displayName += " — " + preview.Sheet
	}
	view := PreviewSource{
		ProjectID: projectID, ID: id, DisplayName: displayName, TableName: database.NormalizeIdentifier(displayName),
		SourcePath: preview.File.Path, Kind: string(preview.File.Type), Sheet: preview.Sheet,
		Size: preview.File.Size, Status: "preparing", Columns: preview.Columns, PreviewRows: preview.Rows,
	}
	// Publish the source before starting work so a very fast failure can always
	// be applied to an existing frontend record.
	a.emit("ducs:dataset-preview", map[string]any{"projectId": projectID, "source": view})
	snapshot, err := a.jobs.Submit(jobs.Metadata{ProjectID: projectID, Kind: "import", Label: displayName, SourceID: id}, func(ctx context.Context, reporter jobs.Reporter) (any, error) {
		reporter.Update(0, "Materializing in DuckDB…")
		source, importErr := a.imports.Materialize(ctx, importers.MaterializeRequest{
			ProjectID: projectID, ID: id, Path: preview.File.Path, DisplayName: displayName,
			Sheet: preview.Sheet, Options: options,
		})
		if importErr != nil {
			diagnosed := a.recordImportFailure(importErr, diagnostic)
			a.emit("ducs:dataset-failed", map[string]any{
				"projectId": projectID, "sourceId": id, "error": diagnosed,
			})
			return nil, diagnosed
		}
		reporter.Update(1, "Ready")
		a.logImportSucceeded(diagnostic, source.RowCount, len(source.Columns))
		a.emit("ducs:dataset-ready", map[string]any{"projectId": projectID, "source": source})
		return source, nil
	})
	if err != nil {
		diagnosed := a.recordImportFailure(err, diagnostic)
		view.Status = "failed"
		view.Error = diagnosed
		a.emit("ducs:dataset-failed", map[string]any{"projectId": projectID, "sourceId": id, "error": diagnosed})
		return view, nil, nil
	}
	return view, &snapshot, nil
}

func failedPreview(projectID, path, kind string, cause error) (PreviewSource, error) {
	id, err := models.NewID()
	if err != nil {
		return PreviewSource{}, models.WrapError(models.CodeDatabase, "Could not create an import ID", err, nil)
	}
	return failedPreviewWithID(projectID, id, path, kind, cause)
}

func failedPreviewWithID(projectID, id, path, kind string, cause error) (PreviewSource, error) {
	name := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
	if name == "" || name == "." {
		name = "Import"
	}
	if kind == "" {
		kind = stringFromExtension(path)
	}
	return PreviewSource{
		ProjectID: projectID, ID: id, DisplayName: name, TableName: database.NormalizeIdentifier(name),
		SourcePath: path, Kind: kind, Status: "failed", Columns: []models.ColumnInfo{},
		Error: models.AsAppError(cause),
	}, nil
}

func stringFromExtension(path string) string {
	return strings.TrimPrefix(strings.ToLower(filepath.Ext(path)), ".")
}

func (a *App) GetSource(request ProjectResourceRequest) (models.SourceInfo, error) {
	if err := a.ready(); err != nil {
		return models.SourceInfo{}, err
	}
	return a.workspace.GetSource(a.ctx, request.ProjectID, request.ID)
}

func (a *App) RenameSource(request RenameSourceRequest) (models.SourceInfo, error) {
	if err := a.ready(); err != nil {
		return models.SourceInfo{}, err
	}
	return a.workspace.RenameSource(a.ctx, request.ProjectID, request.ID, request.DisplayName)
}

func (a *App) GetRows(request grid.RowsRequest) (grid.RowsResponse, error) {
	if err := a.ready(); err != nil {
		return grid.RowsResponse{}, err
	}
	return a.grid.GetRows(a.ctx, request)
}

func (a *App) GetCellValue(request CellValueRequest) (CellValueResponse, error) {
	if err := a.ready(); err != nil {
		return CellValueResponse{}, err
	}
	if request.RowIndex < 0 {
		return CellValueResponse{}, models.NewError(models.CodeInvalidArgument, "Row index cannot be negative", nil)
	}
	built, err := a.grid.BuildSelect(a.ctx, grid.SelectRequest{
		ProjectID: request.ProjectID, Resource: request.Resource, SourceID: request.SourceID, Columns: []string{request.Column}, Sorts: request.Sorts,
		Filters: request.Filters, Offset: request.RowIndex, Limit: 1,
	}, true)
	if err != nil {
		return CellValueResponse{}, err
	}
	values, err := a.grid.ExecuteSelect(a.ctx, built)
	if err != nil {
		return CellValueResponse{}, err
	}
	if len(values) == 0 {
		return CellValueResponse{}, models.NewError(models.CodeNotFound, "The selected row no longer exists", nil)
	}
	return CellValueResponse{Value: values[0][request.Column]}, nil
}

func (a *App) CountRows(request CountRowsRequest) (CountRowsResponse, error) {
	if err := a.ready(); err != nil {
		return CountRowsResponse{}, err
	}
	resource := request.Resource
	if resource.Kind == "" {
		resource = models.GridResourceRef{Kind: "source", SourceID: request.SourceID}
	}
	count, err := a.grid.CountResource(a.ctx, request.ProjectID, resource, request.Filters)
	return CountRowsResponse{Count: count}, err
}

func (a *App) RunQuery(request RunQueryRequest) (query.QueryResultInfo, error) {
	if err := a.ready(); err != nil {
		return query.QueryResultInfo{}, err
	}
	if err := a.validateProject(request.ProjectID); err != nil {
		return query.QueryResultInfo{}, err
	}
	snapshot, err := a.jobs.Submit(jobs.Metadata{ProjectID: request.ProjectID, Kind: "query", Label: "SQL query"}, func(ctx context.Context, reporter jobs.Reporter) (any, error) {
		reporter.Update(0, "Running SQL in DuckDB…")
		return a.queries.Run(ctx, request.ProjectID, request.SQL)
	})
	if err != nil {
		return query.QueryResultInfo{}, err
	}
	final, err := a.jobs.Wait(a.ctx, snapshot.ID)
	if err != nil {
		return query.QueryResultInfo{}, models.AsAppError(err)
	}
	if final.Error != nil {
		return query.QueryResultInfo{}, final.Error
	}
	result, ok := final.Result.(query.QueryResultInfo)
	if !ok {
		return query.QueryResultInfo{}, models.NewError(models.CodeDatabase, "Query result could not be read", nil)
	}
	a.emit("ducs:result-ready", map[string]any{"projectId": request.ProjectID, "source": result.Source})
	return result, nil
}

func (a *App) SaveQuery(request SaveQueryRequest) (models.SavedQuery, error) {
	if err := a.ready(); err != nil {
		return models.SavedQuery{}, err
	}
	if strings.TrimSpace(request.ID) == "" {
		return a.workspace.CreateSavedQuery(a.ctx, request.ProjectID, request.Name, request.SQL)
	}
	return a.workspace.UpdateSavedQuery(a.ctx, request.ProjectID, request.ID, request.Name, request.SQL)
}

func (a *App) DeleteSavedQuery(request ProjectResourceRequest) error {
	if err := a.ready(); err != nil {
		return err
	}
	return a.workspace.DeleteSavedQuery(a.ctx, request.ProjectID, request.ID)
}

func (a *App) SaveResultAsTable(request query.SaveResultRequest) (models.SourceInfo, error) {
	if err := a.ready(); err != nil {
		return models.SourceInfo{}, err
	}
	return a.queries.SaveResult(a.ctx, request)
}

func (a *App) CloseResult(request ProjectResourceRequest) error {
	if err := a.ready(); err != nil {
		return err
	}
	return a.queries.CloseResult(a.ctx, request.ProjectID, request.ID)
}

func (a *App) RemoveDataset(request ProjectResourceRequest) error {
	if err := a.ready(); err != nil {
		return err
	}
	return a.workspace.RemoveDataset(a.ctx, request.ProjectID, request.ID)
}

func (a *App) ExportCSV(request ExportRequest) (exportservice.Result, error) {
	if err := a.ready(); err != nil {
		return exportservice.Result{}, err
	}
	resource := request.Resource
	if resource.Kind == "" {
		resource = models.GridResourceRef{Kind: "source", SourceID: request.SourceID}
	}
	destination := strings.TrimSpace(request.Destination)
	var exportName, exportID string
	if destination == "" {
		if resource.Kind == "external" {
			relation, relationErr := a.connections.GetExternalRelation(a.ctx, request.ProjectID, resource.RelationID)
			if relationErr != nil {
				return exportservice.Result{}, relationErr
			}
			exportName = relation.Name
			exportID = relation.ID
		} else {
			source, sourceErr := a.workspace.GetSource(a.ctx, request.ProjectID, resource.SourceID)
			if sourceErr != nil {
				return exportservice.Result{}, sourceErr
			}
			exportName = source.DisplayName
			exportID = source.ID
		}
		filename := safeFilename(exportName) + ".csv"
		var pickerErr error
		destination, pickerErr = runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
			Title: "Export CSV", DefaultFilename: filename,
			Filters:              []runtime.FileFilter{{DisplayName: "CSV file (*.csv)", Pattern: "*.csv"}},
			CanCreateDirectories: true,
		})
		if pickerErr != nil {
			return exportservice.Result{}, models.WrapError(models.CodeIO, "The export destination could not be selected", pickerErr, nil)
		}
		if destination == "" {
			return exportservice.Result{}, models.NewError(models.CodeCancelled, "Export was cancelled", nil)
		}
	}
	if exportName == "" {
		if resource.Kind == "external" {
			relation, relationErr := a.connections.GetExternalRelation(a.ctx, request.ProjectID, resource.RelationID)
			if relationErr != nil {
				return exportservice.Result{}, relationErr
			}
			exportName = relation.Name
			exportID = relation.ID
		} else {
			source, sourceErr := a.workspace.GetSource(a.ctx, request.ProjectID, resource.SourceID)
			if sourceErr != nil {
				return exportservice.Result{}, sourceErr
			}
			exportName = source.DisplayName
			exportID = source.ID
		}
	}
	job, err := a.jobs.Submit(jobs.Metadata{ProjectID: request.ProjectID, Kind: "export", Label: exportName, SourceID: exportID}, func(ctx context.Context, reporter jobs.Reporter) (any, error) {
		reporter.Update(0, "Exporting CSV with DuckDB…")
		return a.exports.ExportCSV(ctx, exportservice.CSVRequest{
			ProjectID: request.ProjectID, Resource: resource, SourceID: request.SourceID, Destination: destination, Scope: exportservice.Scope(request.Scope),
			Filters: request.Filters, Sorts: request.Sorts, VisibleColumns: request.VisibleColumns,
		})
	})
	if err != nil {
		return exportservice.Result{}, err
	}
	final, err := a.jobs.Wait(a.ctx, job.ID)
	if err != nil {
		return exportservice.Result{}, models.AsAppError(err)
	}
	if final.Error != nil {
		return exportservice.Result{}, final.Error
	}
	result, ok := final.Result.(exportservice.Result)
	if !ok {
		return exportservice.Result{}, models.NewError(models.CodeDatabase, "Export result could not be read", nil)
	}
	return result, nil
}

func safeFilename(name string) string {
	name = strings.TrimSpace(name)
	name = strings.Map(func(r rune) rune {
		switch r {
		case '/', ':', 0:
			return '_'
		default:
			return r
		}
	}, name)
	if name == "" {
		return "ducs-table-export"
	}
	return name
}

func (a *App) ListGlobalConnections() ([]connections.ConnectionInfo, error) {
	if err := a.ready(); err != nil {
		return nil, err
	}
	return a.connections.ListConnections(a.ctx)
}

// ListConnections remains a compatibility alias for older generated bindings.
func (a *App) ListConnections() ([]connections.ConnectionInfo, error) {
	return a.ListGlobalConnections()
}

func (a *App) AttachConnectionToProject(request ProjectConnectionRequest) error {
	if err := a.ready(); err != nil {
		return err
	}
	if err := a.workspace.AttachConnection(a.ctx, request.ProjectID, request.ConnectionID); err != nil {
		return err
	}
	info, err := a.connections.GetConnection(a.ctx, request.ConnectionID)
	if err == nil && info.AutoConnect {
		a.scheduleAutoConnect(request.ProjectID, []connections.ConnectionInfo{info})
	}
	return err
}

func (a *App) DetachConnectionFromProject(request ProjectConnectionRequest) error {
	if err := a.ready(); err != nil {
		return err
	}
	if err := a.workspace.DetachConnection(a.ctx, request.ProjectID, request.ConnectionID); err != nil {
		return err
	}
	session, err := a.workspace.LoadSession(a.ctx, request.ProjectID)
	if err != nil {
		return err
	}
	tabs := session.Tabs[:0]
	for _, tab := range session.Tabs {
		if tab.Kind == models.ProjectTabKindExternal && tab.ConnectionID == request.ConnectionID {
			continue
		}
		tabs = append(tabs, tab)
	}
	session.Tabs = tabs
	workspace.NormalizeSession(&session)
	return a.workspace.SaveSession(a.ctx, request.ProjectID, session)
}

func (a *App) ConnectionUsageCount(connectionID string) (int, error) {
	if err := a.ready(); err != nil {
		return 0, err
	}
	return a.workspace.ConnectionUsageCount(a.ctx, connectionID)
}

func (a *App) CreateConnection(request connections.CreateConnectionRequest) (connections.ConnectionInfo, error) {
	if err := a.ready(); err != nil {
		return connections.ConnectionInfo{}, err
	}
	return a.connections.CreateConnection(a.ctx, request)
}

func (a *App) UpdateConnection(request connections.UpdateConnectionRequest) (connections.ConnectionInfo, error) {
	if err := a.ready(); err != nil {
		return connections.ConnectionInfo{}, err
	}
	return a.connections.UpdateConnection(a.ctx, request)
}

func (a *App) DeleteConnection(id string) error {
	if err := a.ready(); err != nil {
		return err
	}
	return a.connections.DeleteConnection(a.ctx, id)
}

func (a *App) TestConnection(request connections.TestConnectionRequest) error {
	if err := a.ready(); err != nil {
		return err
	}
	return a.connections.TestConnection(a.ctx, request)
}

func (a *App) ConnectConnection(request connections.ConnectRequest) (connections.ConnectionInfo, error) {
	if err := a.ready(); err != nil {
		return connections.ConnectionInfo{}, err
	}
	return a.connections.Connect(a.ctx, request.ProjectID, request.ID)
}

func (a *App) DisconnectConnection(request connections.ConnectRequest) error {
	if err := a.ready(); err != nil {
		return err
	}
	return a.connections.Disconnect(a.ctx, request.ProjectID, request.ID)
}

func (a *App) RefreshConnectionCatalog(request connections.ConnectRequest) error {
	if err := a.ready(); err != nil {
		return err
	}
	if err := a.connections.RefreshCatalog(a.ctx, request.ProjectID, request.ID); err != nil {
		return err
	}
	a.emit("ducs:catalog-invalidated", map[string]any{"projectId": request.ProjectID, "connectionId": request.ID})
	return nil
}

func (a *App) ListConnectionSchemas(request connections.ConnectRequest) ([]connections.SchemaInfo, error) {
	if err := a.ready(); err != nil {
		return nil, err
	}
	return a.connections.ListSchemas(a.ctx, request.ProjectID, request.ID)
}

func (a *App) ListExternalRelations(request connections.ListRelationsRequest) ([]models.ExternalRelationInfo, error) {
	if err := a.ready(); err != nil {
		return nil, err
	}
	return a.connections.ListRelations(a.ctx, request)
}

func (a *App) GetExternalRelation(request ProjectResourceRequest) (models.ExternalRelationInfo, error) {
	if err := a.ready(); err != nil {
		return models.ExternalRelationInfo{}, err
	}
	return a.connections.GetExternalRelation(a.ctx, request.ProjectID, request.ID)
}

func (a *App) SnapshotExternalRelation(request connections.SnapshotRequest) (jobs.Snapshot, error) {
	if err := a.ready(); err != nil {
		return jobs.Snapshot{}, err
	}
	job, err := a.jobs.Submit(jobs.Metadata{ProjectID: request.ProjectID, Kind: "snapshot", Label: "Snapshot external relation", SourceID: request.RelationID}, func(ctx context.Context, reporter jobs.Reporter) (any, error) {
		reporter.Update(0, "Copying the live relation locally…")
		source, snapshotErr := a.connections.CreateSnapshot(ctx, request)
		if snapshotErr != nil {
			a.emit("ducs:snapshot-failed", map[string]any{"projectId": request.ProjectID, "relationId": request.RelationID, "error": models.AsAppError(snapshotErr)})
			return nil, snapshotErr
		}
		reporter.Update(1, "Snapshot ready")
		a.emit("ducs:snapshot-ready", map[string]any{"projectId": request.ProjectID, "source": source})
		return source, nil
	})
	return job, err
}

func (a *App) RefreshSnapshot(request connections.RefreshSnapshotRequest) (jobs.Snapshot, error) {
	if err := a.ready(); err != nil {
		return jobs.Snapshot{}, err
	}
	job, err := a.jobs.Submit(jobs.Metadata{ProjectID: request.ProjectID, Kind: "snapshot-refresh", Label: "Refresh snapshot", SourceID: request.SourceID}, func(ctx context.Context, reporter jobs.Reporter) (any, error) {
		reporter.Update(0, "Refreshing snapshot while keeping the current version available…")
		source, refreshErr := a.connections.RefreshSnapshot(ctx, request.ProjectID, request.SourceID)
		if refreshErr != nil {
			a.emit("ducs:snapshot-failed", map[string]any{"projectId": request.ProjectID, "sourceId": request.SourceID, "error": models.AsAppError(refreshErr)})
			return nil, refreshErr
		}
		reporter.Update(1, "Snapshot refreshed")
		a.emit("ducs:snapshot-ready", map[string]any{"projectId": request.ProjectID, "source": source})
		return source, nil
	})
	return job, err
}

func (a *App) CancelJob(id string) (jobs.Snapshot, error) {
	if err := a.ready(); err != nil {
		return jobs.Snapshot{}, err
	}
	return a.jobs.Cancel(id)
}
