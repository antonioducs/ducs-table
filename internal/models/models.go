// Package models contains the stable data contracts shared by backend services.
package models

import "time"

// ColumnInfo describes a physical DuckDB column.
type ColumnInfo struct {
	Name     string `json:"name"`
	Type     string `json:"type"`
	Nullable bool   `json:"nullable"`
	Ordinal  int    `json:"ordinal"`
}

// SourceInfo describes either a persistent imported dataset or an ephemeral
// query result. SQLName and Schema are internal, already-validated catalog names.
type SourceInfo struct {
	ID          string       `json:"id"`
	DisplayName string       `json:"displayName"`
	SQLName     string       `json:"sqlName"`
	Schema      string       `json:"schema"`
	SourceType  string       `json:"sourceType"`
	SourcePath  string       `json:"sourcePath,omitempty"`
	Sheet       string       `json:"sheet,omitempty"`
	RowCount    int64        `json:"rowCount"`
	Columns     []ColumnInfo `json:"columns"`
	IsEphemeral bool         `json:"isEphemeral"`
	OriginalSQL string       `json:"originalSql,omitempty"`
	CreatedAt   time.Time    `json:"createdAt"`
	UpdatedAt   time.Time    `json:"updatedAt"`
}

// SavedQuery is a named, persistent SQL query.
type SavedQuery struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	SQL       string    `json:"sql"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// BootstrapState is the complete small metadata payload needed at application
// startup. Table rows are intentionally not included.
type BootstrapState struct {
	Datasets     []SourceInfo `json:"datasets"`
	Results      []SourceInfo `json:"results"`
	SavedQueries []SavedQuery `json:"savedQueries"`
}
