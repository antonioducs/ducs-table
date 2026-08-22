package main

import (
	"context"
	"path/filepath"
	"strings"
	"sync"
	"time"

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
	ctx             context.Context
	cancel          context.CancelFunc
	db              *database.DB
	workspace       *workspace.Service
	imports         *importers.Service
	grid            *grid.Service
	queries         *query.Service
	exports         *exportservice.Service
	jobs            *jobs.Manager
	extensions      *extensions.Manager
	federated       *federation.Session
	connections     *connections.Service
	startupErr      error
	closeOnce       sync.Once
	autoConnectOnce sync.Once
}

func NewApp() *App { return &App{} }

func (a *App) startup(ctx context.Context) {
	a.ctx, a.cancel = context.WithCancel(ctx)
	paths, err := apppaths.Default()
	if err != nil {
		a.startupErr = err
		return
	}
	db, err := database.Open(a.ctx, paths)
	if err != nil {
		a.startupErr = err
		return
	}
	a.db = db
	a.jobs = jobs.NewManagerWithContext(a.ctx, 2, func(snapshot jobs.Snapshot) {
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
	runtime.OnFileDrop(a.ctx, func(_, _ int, paths []string) {
		if len(paths) > 0 {
			a.emit("ducs:file-drop", map[string]any{"paths": paths})
		}
	})
}

func (a *App) shutdown(context.Context) {
	a.closeOnce.Do(func() {
		if a.ctx != nil {
			runtime.OnFileDropOff(a.ctx)
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
	})
}

func (a *App) ready() error {
	if a.startupErr != nil {
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
	state, err := a.workspace.Bootstrap(a.ctx)
	if err != nil {
		return BootstrapState{}, err
	}
	connectionList, err := a.connections.ListConnections(a.ctx)
	if err != nil {
		return BootstrapState{}, err
	}
	result := BootstrapState{
		Datasets: state.Datasets, Results: state.Results, SavedQueries: state.SavedQueries,
		Jobs: a.jobs.List(), Connections: connectionList, Ready: true,
	}
	a.autoConnectOnce.Do(func() {
		items := append([]connections.ConnectionInfo(nil), connectionList...)
		go func() {
			select {
			case <-a.ctx.Done():
				return
			case <-time.After(100 * time.Millisecond):
			}
			for _, info := range items {
				if !info.AutoConnect {
					continue
				}
				connectionID := info.ID
				_, _ = a.jobs.SubmitWithMetadata("connection", "Connect "+info.Name, "", func(ctx context.Context, reporter jobs.Reporter) (any, error) {
					reporter.Update(0, "Connecting external database…")
					connected, connectErr := a.connections.Connect(ctx, connectionID)
					if connectErr == nil {
						reporter.Update(1, "Connected")
					}
					return connected, connectErr
				})
			}
		}()
	})
	return result, nil
}

func (a *App) OpenFiles() (ImportPathsResult, error) {
	if err := a.ready(); err != nil {
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
	return a.ImportPaths(ImportPathsRequest{Paths: paths})
}

func (a *App) ImportPaths(request ImportPathsRequest) (ImportPathsResult, error) {
	if err := a.ready(); err != nil {
		return ImportPathsResult{}, err
	}
	result := ImportPathsResult{
		Sources: make([]PreviewSource, 0, len(request.Paths)),
		Jobs:    make([]jobs.Snapshot, 0, len(request.Paths)),
	}
	for _, path := range request.Paths {
		file, err := a.imports.Validate(path)
		if err != nil {
			failed, idErr := failedPreview(path, "", err)
			if idErr != nil {
				return result, idErr
			}
			result.Sources = append(result.Sources, failed)
			continue
		}
		if file.Type == importers.FileXLSX {
			sheets, sheetErr := a.imports.ListSheets(file.Path)
			if sheetErr != nil {
				failed, idErr := failedPreview(file.Path, string(file.Type), sheetErr)
				if idErr != nil {
					return result, idErr
				}
				result.Sources = append(result.Sources, failed)
				continue
			}
			if len(sheets) > 1 {
				result.Workbooks = append(result.Workbooks, WorkbookSheets{
					Path: file.Path, DisplayName: file.Name, Sheets: sheets,
				})
				continue
			}
			preview, job, startErr := a.startImport(file.Path, sheets[0], request.Options)
			if startErr != nil {
				return result, startErr
			}
			result.Sources = append(result.Sources, preview)
			if job != nil {
				result.Jobs = append(result.Jobs, *job)
			}
			continue
		}
		preview, job, startErr := a.startImport(file.Path, "", request.Options)
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

func (a *App) ListWorkbookSheets(path string) (WorkbookSheets, error) {
	if err := a.ready(); err != nil {
		return WorkbookSheets{}, err
	}
	file, err := a.imports.Validate(path)
	if err != nil {
		return WorkbookSheets{}, err
	}
	sheets, err := a.imports.ListSheets(file.Path)
	if err != nil {
		return WorkbookSheets{}, err
	}
	return WorkbookSheets{Path: file.Path, DisplayName: file.Name, Sheets: sheets}, nil
}

func (a *App) StartXLSXImport(request XLSXImportRequest) (ImportPathsResult, error) {
	if err := a.ready(); err != nil {
		return ImportPathsResult{}, err
	}
	if len(request.Sheets) == 0 {
		return ImportPathsResult{}, models.NewError(models.CodeInvalidArgument, "Choose a worksheet to import", nil)
	}
	result := ImportPathsResult{Sources: make([]PreviewSource, 0, len(request.Sheets)), Jobs: make([]jobs.Snapshot, 0, len(request.Sheets))}
	for _, sheet := range request.Sheets {
		preview, job, err := a.startImport(request.Path, sheet, request.Options)
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

func (a *App) startImport(path, sheet string, options importers.Options) (PreviewSource, *jobs.Snapshot, error) {
	id, err := models.NewID()
	if err != nil {
		return PreviewSource{}, nil, models.WrapError(models.CodeDatabase, "Could not create an import ID", err, nil)
	}
	preview, err := a.imports.Preview(a.ctx, path, options, sheet, 200)
	if err != nil {
		failed, failedErr := failedPreviewWithID(id, path, stringFromExtension(path), err)
		return failed, nil, failedErr
	}
	displayName := strings.TrimSuffix(preview.File.Name, filepath.Ext(preview.File.Name))
	if preview.Sheet != "" {
		displayName += " — " + preview.Sheet
	}
	view := PreviewSource{
		ID: id, DisplayName: displayName, TableName: database.NormalizeIdentifier(displayName),
		SourcePath: preview.File.Path, Kind: string(preview.File.Type), Sheet: preview.Sheet,
		Size: preview.File.Size, Status: "preparing", Columns: preview.Columns, PreviewRows: preview.Rows,
	}
	snapshot, err := a.jobs.SubmitWithMetadata("import", displayName, id, func(ctx context.Context, reporter jobs.Reporter) (any, error) {
		reporter.Update(0, "Materializing in DuckDB…")
		source, importErr := a.imports.Materialize(ctx, importers.MaterializeRequest{
			ID: id, Path: preview.File.Path, DisplayName: displayName,
			Sheet: preview.Sheet, Options: options,
		})
		if importErr != nil {
			a.emit("ducs:dataset-failed", map[string]any{
				"sourceId": id, "error": models.AsAppError(importErr),
			})
			return nil, importErr
		}
		reporter.Update(1, "Ready")
		a.emit("ducs:dataset-ready", source)
		return source, nil
	})
	if err != nil {
		return PreviewSource{}, nil, err
	}
	a.emit("ducs:dataset-preview", view)
	return view, &snapshot, nil
}

func failedPreview(path, kind string, cause error) (PreviewSource, error) {
	id, err := models.NewID()
	if err != nil {
		return PreviewSource{}, models.WrapError(models.CodeDatabase, "Could not create an import ID", err, nil)
	}
	return failedPreviewWithID(id, path, kind, cause)
}

func failedPreviewWithID(id, path, kind string, cause error) (PreviewSource, error) {
	name := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
	if name == "" || name == "." {
		name = "Import"
	}
	if kind == "" {
		kind = stringFromExtension(path)
	}
	return PreviewSource{
		ID: id, DisplayName: name, TableName: database.NormalizeIdentifier(name),
		SourcePath: path, Kind: kind, Status: "failed", Columns: []models.ColumnInfo{},
		Error: models.AsAppError(cause),
	}, nil
}

func stringFromExtension(path string) string {
	return strings.TrimPrefix(strings.ToLower(filepath.Ext(path)), ".")
}

func (a *App) GetSource(sourceID string) (models.SourceInfo, error) {
	if err := a.ready(); err != nil {
		return models.SourceInfo{}, err
	}
	return a.workspace.GetSource(a.ctx, sourceID)
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
		Resource: request.Resource, SourceID: request.SourceID, Columns: []string{request.Column}, Sorts: request.Sorts,
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
	count, err := a.grid.CountResource(a.ctx, resource, request.Filters)
	return CountRowsResponse{Count: count}, err
}

func (a *App) RunQuery(request RunQueryRequest) (query.QueryResultInfo, error) {
	if err := a.ready(); err != nil {
		return query.QueryResultInfo{}, err
	}
	snapshot, err := a.jobs.SubmitWithMetadata("query", "SQL query", "", func(ctx context.Context, reporter jobs.Reporter) (any, error) {
		reporter.Update(0, "Running SQL in DuckDB…")
		return a.queries.Run(ctx, request.SQL)
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
	a.emit("ducs:result-ready", result)
	return result, nil
}

func (a *App) SaveQuery(request SaveQueryRequest) (models.SavedQuery, error) {
	if err := a.ready(); err != nil {
		return models.SavedQuery{}, err
	}
	if strings.TrimSpace(request.ID) == "" {
		return a.workspace.CreateSavedQuery(a.ctx, request.Name, request.SQL)
	}
	return a.workspace.UpdateSavedQuery(a.ctx, request.ID, request.Name, request.SQL)
}

func (a *App) DeleteSavedQuery(id string) error {
	if err := a.ready(); err != nil {
		return err
	}
	return a.workspace.DeleteSavedQuery(a.ctx, id)
}

func (a *App) SaveResultAsTable(request query.SaveResultRequest) (models.SourceInfo, error) {
	if err := a.ready(); err != nil {
		return models.SourceInfo{}, err
	}
	return a.queries.SaveResult(a.ctx, request)
}

func (a *App) CloseResult(id string) error {
	if err := a.ready(); err != nil {
		return err
	}
	return a.queries.CloseResult(a.ctx, id)
}

func (a *App) RemoveDataset(id string) error {
	if err := a.ready(); err != nil {
		return err
	}
	return a.workspace.RemoveDataset(a.ctx, id)
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
			relation, relationErr := a.connections.GetExternalRelation(a.ctx, resource.RelationID)
			if relationErr != nil {
				return exportservice.Result{}, relationErr
			}
			exportName = relation.Name
			exportID = relation.ID
		} else {
			source, sourceErr := a.workspace.GetSource(a.ctx, resource.SourceID)
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
			relation, relationErr := a.connections.GetExternalRelation(a.ctx, resource.RelationID)
			if relationErr != nil {
				return exportservice.Result{}, relationErr
			}
			exportName = relation.Name
			exportID = relation.ID
		} else {
			source, sourceErr := a.workspace.GetSource(a.ctx, resource.SourceID)
			if sourceErr != nil {
				return exportservice.Result{}, sourceErr
			}
			exportName = source.DisplayName
			exportID = source.ID
		}
	}
	job, err := a.jobs.SubmitWithMetadata("export", exportName, exportID, func(ctx context.Context, reporter jobs.Reporter) (any, error) {
		reporter.Update(0, "Exporting CSV with DuckDB…")
		return a.exports.ExportCSV(ctx, exportservice.CSVRequest{
			Resource: resource, SourceID: request.SourceID, Destination: destination, Scope: exportservice.Scope(request.Scope),
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

func (a *App) ListConnections() ([]connections.ConnectionInfo, error) {
	if err := a.ready(); err != nil {
		return nil, err
	}
	return a.connections.ListConnections(a.ctx)
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
	return a.connections.Connect(a.ctx, request.ID)
}

func (a *App) DisconnectConnection(id string) error {
	if err := a.ready(); err != nil {
		return err
	}
	return a.connections.Disconnect(a.ctx, id)
}

func (a *App) RefreshConnectionCatalog(id string) error {
	if err := a.ready(); err != nil {
		return err
	}
	if err := a.connections.RefreshCatalog(a.ctx, id); err != nil {
		return err
	}
	a.emit("ducs:catalog-invalidated", map[string]any{"connectionId": id})
	return nil
}

func (a *App) ListConnectionSchemas(id string) ([]connections.SchemaInfo, error) {
	if err := a.ready(); err != nil {
		return nil, err
	}
	return a.connections.ListSchemas(a.ctx, id)
}

func (a *App) ListExternalRelations(request connections.ListRelationsRequest) ([]models.ExternalRelationInfo, error) {
	if err := a.ready(); err != nil {
		return nil, err
	}
	return a.connections.ListRelations(a.ctx, request)
}

func (a *App) GetExternalRelation(id string) (models.ExternalRelationInfo, error) {
	if err := a.ready(); err != nil {
		return models.ExternalRelationInfo{}, err
	}
	return a.connections.GetExternalRelation(a.ctx, id)
}

func (a *App) SnapshotExternalRelation(request connections.SnapshotRequest) (jobs.Snapshot, error) {
	if err := a.ready(); err != nil {
		return jobs.Snapshot{}, err
	}
	job, err := a.jobs.SubmitWithMetadata("snapshot", "Snapshot external relation", request.RelationID, func(ctx context.Context, reporter jobs.Reporter) (any, error) {
		reporter.Update(0, "Copying the live relation locally…")
		source, snapshotErr := a.connections.CreateSnapshot(ctx, request)
		if snapshotErr != nil {
			a.emit("ducs:snapshot-failed", map[string]any{"relationId": request.RelationID, "error": models.AsAppError(snapshotErr)})
			return nil, snapshotErr
		}
		reporter.Update(1, "Snapshot ready")
		a.emit("ducs:snapshot-ready", source)
		return source, nil
	})
	return job, err
}

func (a *App) RefreshSnapshot(request connections.RefreshSnapshotRequest) (jobs.Snapshot, error) {
	if err := a.ready(); err != nil {
		return jobs.Snapshot{}, err
	}
	job, err := a.jobs.SubmitWithMetadata("snapshot-refresh", "Refresh snapshot", request.SourceID, func(ctx context.Context, reporter jobs.Reporter) (any, error) {
		reporter.Update(0, "Refreshing snapshot while keeping the current version available…")
		source, refreshErr := a.connections.RefreshSnapshot(ctx, request.SourceID)
		if refreshErr != nil {
			a.emit("ducs:snapshot-failed", map[string]any{"sourceId": request.SourceID, "error": models.AsAppError(refreshErr)})
			return nil, refreshErr
		}
		reporter.Update(1, "Snapshot refreshed")
		a.emit("ducs:snapshot-ready", source)
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
