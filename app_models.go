package main

import (
	"ducs-table/internal/connections"
	"ducs-table/internal/grid"
	"ducs-table/internal/importers"
	"ducs-table/internal/jobs"
	"ducs-table/internal/models"
)

// BootstrapState is intentionally metadata-only. Table rows are always fetched
// through GetRows and never stored in the frontend session state.
type BootstrapState struct {
	Projects        []models.Project `json:"projects"`
	ActiveProjectID string           `json:"activeProjectId"`
	Workspace       ProjectWorkspace `json:"workspace"`
	Jobs            []jobs.Snapshot  `json:"jobs"`
	Ready           bool             `json:"ready"`
}

// ProjectWorkspace is the complete metadata/session payload for one project.
// Connection credentials and table rows are deliberately excluded.
type ProjectWorkspace struct {
	Project           models.Project                `json:"project"`
	Sources           []models.SourceInfo           `json:"sources"`
	SavedQueries      []models.SavedQuery           `json:"savedQueries"`
	Connections       []connections.ConnectionInfo  `json:"connections"`
	ExternalRelations []models.ExternalRelationInfo `json:"externalRelations"`
	Session           models.ProjectSession         `json:"session"`
	Warnings          []*models.AppError            `json:"warnings,omitempty"`
}

type PreviewSource struct {
	ProjectID   string              `json:"projectId"`
	ID          string              `json:"id"`
	DisplayName string              `json:"displayName"`
	TableName   string              `json:"tableName"`
	SourcePath  string              `json:"sourcePath,omitempty"`
	Kind        string              `json:"kind"`
	Sheet       string              `json:"sheet,omitempty"`
	Size        int64               `json:"size,omitempty"`
	RowCount    *int64              `json:"rowCount"`
	Status      string              `json:"status"`
	IsEphemeral bool                `json:"isEphemeral"`
	Columns     []models.ColumnInfo `json:"columns"`
	PreviewRows []map[string]any    `json:"previewRows,omitempty"`
	Error       *models.AppError    `json:"error,omitempty"`
}

type WorkbookSheets struct {
	ProjectID   string   `json:"projectId"`
	Path        string   `json:"path"`
	DisplayName string   `json:"displayName"`
	Sheets      []string `json:"sheets"`
}

type ImportPathsRequest struct {
	ProjectID string            `json:"projectId"`
	Paths     []string          `json:"paths"`
	Options   importers.Options `json:"options"`
}

type ImportPathsResult struct {
	ProjectID string           `json:"projectId"`
	Sources   []PreviewSource  `json:"sources"`
	Jobs      []jobs.Snapshot  `json:"jobs"`
	Workbooks []WorkbookSheets `json:"workbooks,omitempty"`
}

type XLSXImportRequest struct {
	ProjectID string            `json:"projectId"`
	Path      string            `json:"path"`
	Sheets    []string          `json:"sheets"`
	Options   importers.Options `json:"options"`
}

type CountRowsRequest struct {
	ProjectID string                 `json:"projectId"`
	Resource  models.GridResourceRef `json:"resource"`
	SourceID  string                 `json:"sourceId"`
	Filters   []grid.Filter          `json:"filters,omitempty"`
}

type CountRowsResponse struct {
	Count *int64 `json:"count"`
}

type CellValueRequest struct {
	ProjectID string                 `json:"projectId"`
	Resource  models.GridResourceRef `json:"resource"`
	SourceID  string                 `json:"sourceId"`
	RowIndex  int64                  `json:"rowIndex"`
	Column    string                 `json:"column"`
	Sorts     []grid.Sort            `json:"sorts,omitempty"`
	Filters   []grid.Filter          `json:"filters,omitempty"`
}

type CellValueResponse struct {
	Value any `json:"value"`
}

type RunQueryRequest struct {
	ProjectID string `json:"projectId"`
	SQL       string `json:"sql"`
}

type SaveQueryRequest struct {
	ProjectID string `json:"projectId"`
	ID        string `json:"id,omitempty"`
	Name      string `json:"name"`
	SQL       string `json:"sql"`
}

type RenameSourceRequest struct {
	ProjectID   string `json:"projectId"`
	ID          string `json:"id"`
	DisplayName string `json:"displayName"`
}

type ExportRequest struct {
	ProjectID      string                 `json:"projectId"`
	Resource       models.GridResourceRef `json:"resource"`
	SourceID       string                 `json:"sourceId"`
	Destination    string                 `json:"destination,omitempty"`
	Scope          string                 `json:"scope"`
	Filters        []grid.Filter          `json:"filters,omitempty"`
	Sorts          []grid.Sort            `json:"sorts,omitempty"`
	VisibleColumns []string               `json:"visibleColumns,omitempty"`
}

type ProjectCreateRequest struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
}

type ProjectUpdateRequest struct {
	ProjectID   string `json:"projectId"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
}

type ProjectIDRequest struct {
	ProjectID string `json:"projectId"`
}

type ProjectSessionRequest struct {
	ProjectID string                `json:"projectId"`
	Session   models.ProjectSession `json:"session"`
}

type ProjectResourceRequest struct {
	ProjectID string `json:"projectId"`
	ID        string `json:"id"`
}

type WorkbookSheetsRequest struct {
	ProjectID string `json:"projectId"`
	Path      string `json:"path"`
}

type ProjectConnectionRequest struct {
	ProjectID    string `json:"projectId"`
	ConnectionID string `json:"connectionId"`
}
