// Package connections manages safe metadata, lifecycle, catalog browsing, and
// local snapshots for external databases.
package connections

import (
	"time"

	"ducs-table/internal/models"
)

type ConnectionKind string

const (
	KindPostgres ConnectionKind = "postgres"
	KindMongo    ConnectionKind = "mongo"
)

type ConnectionStatus string

const (
	StatusDisconnected ConnectionStatus = "disconnected"
	StatusConnecting   ConnectionStatus = "connecting"
	StatusConnected    ConnectionStatus = "connected"
	StatusError        ConnectionStatus = "error"
)

type PostgresConfig struct {
	Host                  string `json:"host"`
	Port                  int    `json:"port"`
	Database              string `json:"database"`
	Username              string `json:"username"`
	SSLMode               string `json:"sslMode"`
	Schema                string `json:"schema,omitempty"`
	ConnectTimeoutSeconds int    `json:"connectTimeoutSeconds"`
	PoolSize              int    `json:"poolSize"`
}

type MongoConfig struct {
	Mode                  string   `json:"mode"`
	Hosts                 []string `json:"hosts"`
	Database              string   `json:"database"`
	Username              string   `json:"username,omitempty"`
	AuthSource            string   `json:"authSource,omitempty"`
	TLS                   bool     `json:"tls"`
	ReplicaSet            string   `json:"replicaSet,omitempty"`
	DirectConnection      bool     `json:"directConnection,omitempty"`
	ReadPreference        string   `json:"readPreference,omitempty"`
	ConnectTimeoutSeconds int      `json:"connectTimeoutSeconds"`
	ExperimentalConsent   bool     `json:"experimentalConsent"`
}

// ConnectionConfig contains only non-secret values. Exactly one provider
// branch is populated.
type ConnectionConfig struct {
	Postgres *PostgresConfig `json:"postgres,omitempty"`
	Mongo    *MongoConfig    `json:"mongo,omitempty"`
}

type ConnectionInfo struct {
	ID          string           `json:"id"`
	Name        string           `json:"name"`
	Kind        ConnectionKind   `json:"kind"`
	CatalogName string           `json:"catalogName"`
	Config      ConnectionConfig `json:"config"`
	AutoConnect bool             `json:"autoConnect"`
	HasSecret   bool             `json:"hasSecret"`
	Status      ConnectionStatus `json:"status"`
	LastError   *models.AppError `json:"lastError,omitempty"`
	CreatedAt   time.Time        `json:"createdAt"`
	UpdatedAt   time.Time        `json:"updatedAt"`
}

type CreateConnectionRequest struct {
	Name        string           `json:"name"`
	Kind        ConnectionKind   `json:"kind"`
	CatalogName string           `json:"catalogName"`
	Config      ConnectionConfig `json:"config"`
	AutoConnect bool             `json:"autoConnect"`
	Password    string           `json:"password,omitempty"`
}

type UpdateConnectionRequest struct {
	ID          string           `json:"id"`
	Name        string           `json:"name"`
	CatalogName string           `json:"catalogName,omitempty"`
	Config      ConnectionConfig `json:"config"`
	AutoConnect bool             `json:"autoConnect"`
	Password    string           `json:"password,omitempty"`
}

type TestConnectionRequest struct {
	ID       string           `json:"id,omitempty"`
	Kind     ConnectionKind   `json:"kind,omitempty"`
	Config   ConnectionConfig `json:"config"`
	Password string           `json:"password,omitempty"`
}

type ConnectRequest struct {
	ID string `json:"id"`
}

type SchemaInfo struct {
	Name string `json:"name"`
}

type ListRelationsRequest struct {
	ConnectionID string `json:"connectionId"`
	Schema       string `json:"schema"`
}

type SnapshotRequest struct {
	RelationID  string `json:"relationId"`
	DisplayName string `json:"displayName,omitempty"`
	SQLName     string `json:"sqlName,omitempty"`
}

type RefreshSnapshotRequest struct {
	SourceID string `json:"sourceId"`
}
