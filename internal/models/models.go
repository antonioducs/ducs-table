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
	ProjectID   string          `json:"projectId"`
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
	ProjectID string    `json:"projectId"`
	Name      string    `json:"name"`
	SQL       string    `json:"sql"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// Project is an independently restorable workspace. ArchivedAt and
// LastOpenedAt are nil until those lifecycle events occur.
type Project struct {
	ID           string     `json:"id"`
	Name         string     `json:"name"`
	Description  string     `json:"description"`
	ArchivedAt   *time.Time `json:"archivedAt,omitempty"`
	LastOpenedAt *time.Time `json:"lastOpenedAt,omitempty"`
	CreatedAt    time.Time  `json:"createdAt"`
	UpdatedAt    time.Time  `json:"updatedAt"`
}

const (
	ProjectSessionVersion     = 1
	ProjectTabKindLocal       = "local"
	ProjectTabKindExternal    = "external"
	ProjectTabKindPlaceholder = "placeholder"
)

// ProjectTabReference keeps durable local/external identity plus the small
// display hints needed while a relation is unavailable.
type ProjectTabReference struct {
	ID                string `json:"id"`
	Kind              string `json:"kind"` // local | external | placeholder
	Title             string `json:"title,omitempty"`
	SourceID          string `json:"sourceId,omitempty"`
	ConnectionID      string `json:"connectionId,omitempty"`
	RelationID        string `json:"relationId,omitempty"`
	Catalog           string `json:"catalog,omitempty"`
	Schema            string `json:"schema,omitempty"`
	Relation          string `json:"relation,omitempty"`
	RelationType      string `json:"relationType,omitempty"`
	IsResult          bool   `json:"isResult,omitempty"`
	PlaceholderReason string `json:"placeholderReason,omitempty"`
}

// QueryHistoryEntry is one bounded, project-local execution-history item.
type QueryHistoryEntry struct {
	ID         string    `json:"id"`
	SQL        string    `json:"sql"`
	RanAt      time.Time `json:"ranAt"`
	DurationMS *int64    `json:"durationMs,omitempty"`
	Status     string    `json:"status"` // success | error
}

// ProjectSession is the versioned UI state persisted for one project.
type ProjectSession struct {
	Version        int                   `json:"version"`
	SQLDraft       string                `json:"sqlDraft"`
	Tabs           []ProjectTabReference `json:"tabs"`
	ActiveTabID    *string               `json:"activeTabId,omitempty"`
	History        []QueryHistoryEntry   `json:"history"`
	ResultSequence int                   `json:"resultSequence"`
}

// Workspace is the complete small metadata payload for one open project.
// Datasets and Results are retained as convenient partitions of Sources.
type Workspace struct {
	Project       Project        `json:"project"`
	Sources       []SourceInfo   `json:"sources"`
	Datasets      []SourceInfo   `json:"datasets"`
	Results       []SourceInfo   `json:"results"`
	SavedQueries  []SavedQuery   `json:"savedQueries"`
	Session       ProjectSession `json:"session"`
	ConnectionIDs []string       `json:"connectionIds"`
}

// BootstrapState remains a descriptive alias for bridge consumers.
type BootstrapState = Workspace
