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
	ID          string          `json:"id"`
	DisplayName string          `json:"displayName"`
	SQLName     string          `json:"sqlName"`
	Schema      string          `json:"schema"`
	SourceType  string          `json:"sourceType"`
	SourcePath  string          `json:"sourcePath,omitempty"`
	Sheet       string          `json:"sheet,omitempty"`
	RowCount    int64           `json:"rowCount"`
	Columns     []ColumnInfo    `json:"columns"`
	IsEphemeral bool            `json:"isEphemeral"`
	OriginalSQL string          `json:"originalSql,omitempty"`
	Snapshot    *SnapshotOrigin `json:"snapshot,omitempty"`
	CreatedAt   time.Time       `json:"createdAt"`
	UpdatedAt   time.Time       `json:"updatedAt"`
}

// SnapshotOrigin describes the remote relation from which a local dataset was
// copied. ConnectionID is nil after the connection metadata is removed; the
// descriptive origin fields intentionally remain so the snapshot stays useful
// and understandable offline.
type SnapshotOrigin struct {
	ConnectionID   *string   `json:"connectionId,omitempty"`
	ConnectionName string    `json:"connectionName"`
	Catalog        string    `json:"catalog"`
	Schema         string    `json:"schema"`
	Relation       string    `json:"relation"`
	RelationType   string    `json:"relationType"`
	RefreshedAt    time.Time `json:"refreshedAt"`
}

// GridResourceRef keeps local sources and live external relations as separate
// contracts. Exactly one identifier is accepted by the grid resolver.
type GridResourceRef struct {
	Kind       string `json:"kind"` // source | external
	SourceID   string `json:"sourceId,omitempty"`
	RelationID string `json:"relationId,omitempty"`
}

// ExternalRelationInfo is trusted catalog metadata discovered by the backend.
// The frontend sends only ID back to grid/export APIs; QualifiedName is never
// accepted as executable input.
type ExternalRelationInfo struct {
	ID            string       `json:"id"`
	ConnectionID  string       `json:"connectionId"`
	Provider      string       `json:"provider"`
	Catalog       string       `json:"catalog"`
	Schema        string       `json:"schema"`
	Name          string       `json:"name"`
	RelationType  string       `json:"relationType"`
	QualifiedName string       `json:"qualifiedName"`
	Columns       []ColumnInfo `json:"columns"`
	DefaultOrder  []string     `json:"defaultOrder"`
	PagingStable  bool         `json:"pagingStable"`
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
