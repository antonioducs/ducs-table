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
	Datasets     []models.SourceInfo          `json:"datasets"`
	Results      []models.SourceInfo          `json:"results"`
	SavedQueries []models.SavedQuery          `json:"savedQueries"`
	Jobs         []jobs.Snapshot              `json:"jobs"`
	Connections  []connections.ConnectionInfo `json:"connections"`
	Ready        bool                         `json:"ready"`
}

type PreviewSource struct {
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
	Path        string   `json:"path"`
	DisplayName string   `json:"displayName"`
	Sheets      []string `json:"sheets"`
}

type ImportPathsRequest struct {
	Paths   []string          `json:"paths"`
	Options importers.Options `json:"options"`
}

type ImportPathsResult struct {
	Sources   []PreviewSource  `json:"sources"`
	Jobs      []jobs.Snapshot  `json:"jobs"`
	Workbooks []WorkbookSheets `json:"workbooks,omitempty"`
}

type XLSXImportRequest struct {
	Path    string            `json:"path"`
	Sheets  []string          `json:"sheets"`
	Options importers.Options `json:"options"`
}

type CountRowsRequest struct {
	Resource models.GridResourceRef `json:"resource"`
	SourceID string                 `json:"sourceId"`
	Filters  []grid.Filter          `json:"filters,omitempty"`
}

type CountRowsResponse struct {
	Count *int64 `json:"count"`
}

type CellValueRequest struct {
	Resource models.GridResourceRef `json:"resource"`
	SourceID string                 `json:"sourceId"`
	RowIndex int64                  `json:"rowIndex"`
	Column   string                 `json:"column"`
	Sorts    []grid.Sort            `json:"sorts,omitempty"`
	Filters  []grid.Filter          `json:"filters,omitempty"`
}

type CellValueResponse struct {
	Value any `json:"value"`
}

type RunQueryRequest struct {
	SQL string `json:"sql"`
}

type SaveQueryRequest struct {
	ID   string `json:"id,omitempty"`
	Name string `json:"name"`
	SQL  string `json:"sql"`
}

type ExportRequest struct {
	Resource       models.GridResourceRef `json:"resource"`
	SourceID       string                 `json:"sourceId"`
	Destination    string                 `json:"destination,omitempty"`
	Scope          string                 `json:"scope"`
	Filters        []grid.Filter          `json:"filters,omitempty"`
	Sorts          []grid.Sort            `json:"sorts,omitempty"`
	VisibleColumns []string               `json:"visibleColumns,omitempty"`
}
