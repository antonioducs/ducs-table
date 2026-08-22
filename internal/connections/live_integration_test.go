package connections_test

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"ducs-table/internal/connections"
	"ducs-table/internal/credentials"
	"ducs-table/internal/database"
	exports "ducs-table/internal/export"
	"ducs-table/internal/extensions"
	"ducs-table/internal/federation"
	"ducs-table/internal/grid"
	"ducs-table/internal/models"
	"ducs-table/internal/query"
	"ducs-table/internal/workspace"
)

func TestLivePostgres(t *testing.T) {
	host, databaseName, user := os.Getenv("DUCS_TEST_POSTGRES_HOST"), os.Getenv("DUCS_TEST_POSTGRES_DATABASE"), os.Getenv("DUCS_TEST_POSTGRES_USER")
	if host == "" || databaseName == "" || user == "" {
		t.Skip("live PostgreSQL skipped: DUCS_TEST_POSTGRES_HOST, DUCS_TEST_POSTGRES_DATABASE, and DUCS_TEST_POSTGRES_USER are required")
	}
	port := 5432
	if value := os.Getenv("DUCS_TEST_POSTGRES_PORT"); value != "" {
		parsed, err := strconv.Atoi(value)
		if err != nil {
			t.Fatal(err)
		}
		port = parsed
	}
	sslMode := os.Getenv("DUCS_TEST_POSTGRES_SSLMODE")
	if sslMode == "" {
		sslMode = "prefer"
	}
	runLiveProvider(t, connections.CreateConnectionRequest{Name: "Live PostgreSQL", Kind: connections.KindPostgres, CatalogName: "live_pg", Password: os.Getenv("DUCS_TEST_POSTGRES_PASSWORD"), Config: connections.ConnectionConfig{Postgres: &connections.PostgresConfig{Host: host, Port: port, Database: databaseName, Username: user, SSLMode: sslMode, Schema: os.Getenv("DUCS_TEST_POSTGRES_SCHEMA"), ConnectTimeoutSeconds: 15, PoolSize: 2}}})
}

func TestLiveMongo(t *testing.T) {
	hosts, databaseName := os.Getenv("DUCS_TEST_MONGO_HOSTS"), os.Getenv("DUCS_TEST_MONGO_DATABASE")
	if hosts == "" || databaseName == "" {
		t.Skip("live MongoDB skipped: DUCS_TEST_MONGO_HOSTS and DUCS_TEST_MONGO_DATABASE are required")
	}
	mode := os.Getenv("DUCS_TEST_MONGO_MODE")
	if mode == "" {
		mode = "mongodb"
	}
	runLiveProvider(t, connections.CreateConnectionRequest{Name: "Live MongoDB", Kind: connections.KindMongo, CatalogName: "live_mongo", Password: os.Getenv("DUCS_TEST_MONGO_PASSWORD"), Config: connections.ConnectionConfig{Mongo: &connections.MongoConfig{Mode: mode, Hosts: strings.Split(hosts, ","), Database: databaseName, Username: os.Getenv("DUCS_TEST_MONGO_USER"), AuthSource: os.Getenv("DUCS_TEST_MONGO_AUTH_SOURCE"), TLS: os.Getenv("DUCS_TEST_MONGO_TLS") == "1", ReadPreference: "secondaryPreferred", ConnectTimeoutSeconds: 15, ExperimentalConsent: true}}})
}

func runLiveProvider(t *testing.T, request connections.CreateConnectionRequest) {
	t.Helper()
	ctx := context.Background()
	db, err := database.OpenPath(ctx, filepath.Join(t.TempDir(), "workspace.duckdb"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ws := workspace.New(db)
	project, err := ws.InitialProject(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if project.Name != "My Workspace" {
		t.Fatalf("initial project = %q, want My Workspace", project.Name)
	}
	request.ProjectID = project.ID
	session, err := federation.New(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	service := connections.NewService(db, session, credentials.NewMemoryStore(), extensions.NewManager(), ws, nil)
	defer service.Shutdown()
	created, err := service.CreateConnection(ctx, request)
	if err != nil {
		t.Fatal(err)
	}
	if err := service.TestConnection(ctx, connections.TestConnectionRequest{ID: created.ID}); err != nil {
		t.Fatalf("test connection: %v", err)
	}
	if _, err := service.Connect(ctx, project.ID, created.ID); err != nil {
		t.Fatalf("connect: %v", err)
	}
	schemas, err := service.ListSchemas(ctx, project.ID, created.ID)
	if err != nil {
		t.Fatal(err)
	}
	var relation models.ExternalRelationInfo
	for _, schema := range schemas {
		relations, listErr := service.ListRelations(ctx, connections.ListRelationsRequest{ProjectID: project.ID, ConnectionID: created.ID, Schema: schema.Name})
		if listErr != nil {
			t.Logf("schema %s unavailable: %v", schema.Name, listErr)
			continue
		}
		if len(relations) > 0 {
			relation, err = service.GetExternalRelation(ctx, project.ID, relations[0].ID)
			if err == nil {
				break
			}
		}
	}
	if relation.ID == "" {
		t.Fatal("live fixture exposed no readable relation")
	}
	if _, err := db.SQL().ExecContext(ctx, `CREATE TABLE data.live_marker AS SELECT 1 AS marker`); err != nil {
		t.Fatal(err)
	}
	result, err := query.New(db, session).Run(ctx, project.ID, `SELECT marker.marker, remote.* FROM data.live_marker marker CROSS JOIN `+relation.QualifiedName+` remote LIMIT 5`)
	if err != nil {
		t.Fatalf("federated materialization: %v", err)
	}
	snapshot, err := service.CreateSnapshot(ctx, connections.SnapshotRequest{ProjectID: project.ID, RelationID: relation.ID, DisplayName: "Live fixture snapshot"})
	if err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	gridService := grid.New(db, ws)
	gridService.SetExternalResolver(service)
	exporter := exports.New(db, gridService)
	destination := filepath.Join(t.TempDir(), "result.csv")
	if _, err := exporter.ExportCSV(ctx, exports.CSVRequest{ProjectID: project.ID, Resource: models.GridResourceRef{Kind: "source", SourceID: result.Source.ID}, Destination: destination, Scope: exports.ScopeEntire}); err != nil {
		t.Fatalf("export: %v", err)
	}
	if _, err := os.Stat(destination); err != nil {
		t.Fatal(err)
	}
	if _, err := ws.GetSource(ctx, project.ID, snapshot.ID); err != nil {
		t.Fatal(err)
	}
	if err := service.Disconnect(ctx, project.ID, created.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Connect(ctx, project.ID, created.ID); err != nil {
		t.Fatalf("reconnect: %v", err)
	}
}
