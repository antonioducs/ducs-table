package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"ducs-table/internal/connections"
	"ducs-table/internal/credentials"
	"ducs-table/internal/database"
	"ducs-table/internal/extensions"
	"ducs-table/internal/federation"
	"ducs-table/internal/jobs"
	"ducs-table/internal/workspace"
)

func TestBootstrapEventsAndWorkspaceNeverContainConnectionPassword(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	path := filepath.Join(t.TempDir(), "workspace.duckdb")
	db, err := database.OpenPath(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	session, err := federation.New(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	ws := workspace.New(db)
	project, err := ws.InitialProject(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if project.Name != "My Workspace" {
		t.Fatalf("initial project = %q, want My Workspace", project.Name)
	}
	store := credentials.NewMemoryStore()
	var events []connections.ConnectionInfo
	connectionService := connections.NewService(db, session, store, extensions.NewManager(), ws, func(info connections.ConnectionInfo) { events = append(events, info) })
	manager := jobs.NewManagerWithContext(ctx, 1, nil)
	app := &App{ctx: ctx, cancel: cancel, db: db, workspace: ws, connections: connectionService, jobs: manager}
	const password = "bootstrap-password-marker"
	if _, err := connectionService.CreateConnection(ctx, connections.CreateConnectionRequest{ProjectID: project.ID, Name: "Production", Kind: connections.KindPostgres, CatalogName: "prod", Password: password, Config: connections.ConnectionConfig{Postgres: &connections.PostgresConfig{Host: "localhost", Port: 5432, Database: "app", Username: "reader", SSLMode: "require", ConnectTimeoutSeconds: 10, PoolSize: 4}}}); err != nil {
		t.Fatal(err)
	}
	state, err := app.Bootstrap()
	if err != nil {
		t.Fatal(err)
	}
	if !state.Ready || state.ActiveProjectID != project.ID || state.Workspace.Project.ID != project.ID {
		t.Fatalf("unexpected scoped bootstrap state: %+v", state)
	}
	visible, err := json.Marshal(struct {
		State  BootstrapState               `json:"state"`
		Events []connections.ConnectionInfo `json:"events"`
	}{state, events})
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(visible, []byte(password)) {
		t.Fatalf("password leaked across application boundary: %s", visible)
	}
	cancel()
	_ = manager.Shutdown(context.Background())
	if err := connectionService.Shutdown(); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(contents, []byte(password)) {
		t.Fatal("password was persisted in workspace.duckdb")
	}
}
