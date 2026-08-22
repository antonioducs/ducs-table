// Package grid builds validated, parameterized views over workspace sources.
package grid

import "ducs-table/internal/models"

type Sort struct {
	Column    string `json:"column"`
	Direction string `json:"direction"`
}

type Filter struct {
	Column   string `json:"column"`
	Type     string `json:"type"`
	Operator string `json:"operator"`
	Value    any    `json:"value,omitempty"`
	ValueTo  any    `json:"valueTo,omitempty"`
}

type RowsRequest struct {
	SourceID       string   `json:"sourceId"`
	Offset         int64    `json:"offset"`
	Limit          int      `json:"limit"`
	Sorts          []Sort   `json:"sorts,omitempty"`
	Filters        []Filter `json:"filters,omitempty"`
	VisibleColumns []string `json:"visibleColumns,omitempty"`
}

type RowsResponse struct {
	SourceID  string              `json:"sourceId"`
	Columns   []models.ColumnInfo `json:"columns"`
	Rows      []map[string]any    `json:"rows"`
	Offset    int64               `json:"offset"`
	Limit     int                 `json:"limit"`
	TotalRows int64               `json:"totalRows"`
}

// SelectRequest is shared with export. A zero Limit means no pagination when
// passed to BuildSelect with paginate=false.
type SelectRequest struct {
	SourceID string
	Columns  []string
	Sorts    []Sort
	Filters  []Filter
	Offset   int64
	Limit    int
}

// BuiltSelect is safe to execute: every identifier was resolved against the
// source catalog and every user value is in Args.
type BuiltSelect struct {
	SQL     string
	Args    []any
	Source  models.SourceInfo
	Columns []models.ColumnInfo
}
