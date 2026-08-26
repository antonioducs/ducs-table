package main

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"ducs-table/internal/connections"
	"ducs-table/internal/credentials"
	"ducs-table/internal/database"
	"ducs-table/internal/extensions"
	"ducs-table/internal/federation"
	"ducs-table/internal/jobs"
	"ducs-table/internal/models"
	"ducs-table/internal/workspace"
)

func TestArchiveProjectRejectsQueuedOrRunningJobs(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
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
	if _, err := ws.CreateProject(ctx, "Spare", ""); err != nil {
		t.Fatal(err)
	}
	manager := jobs.NewManagerWithContext(ctx, 1, nil)
	defer manager.Shutdown(context.Background())
	started := make(chan struct{})
	release := make(chan struct{})
	job, err := manager.Submit(jobs.Metadata{ProjectID: project.ID, Kind: "import"}, func(context.Context, jobs.Reporter) (any, error) {
		close(started)
		<-release
		return nil, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("job did not start")
	}
	app := &App{ctx: ctx, db: db, workspace: ws, jobs: manager}
	if _, err := app.ArchiveProject(project.ID); errorCodeForAppTest(err) != models.CodeConflict {
		t.Fatalf("archive with active job error = %#v", err)
	}
	close(release)
	if _, err := manager.Wait(ctx, job.ID); err != nil {
		t.Fatal(err)
	}
	archived, err := app.ArchiveProject(project.ID)
	if err != nil {
		t.Fatal(err)
	}
	if archived.ArchivedAt == nil {
		t.Fatal("project was not archived after its job completed")
	}
}

func TestOpenProjectRestoresDisconnectedExternalTabFromIdentity(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
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
	federated, err := federation.New(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	connectionService := connections.NewService(db, federated, credentials.NewMemoryStore(), extensions.NewManager(), ws, nil)
	defer connectionService.Shutdown()
	connection, err := connectionService.CreateConnection(ctx, connections.CreateConnectionRequest{
		ProjectID: project.ID, Name: "Warehouse", Kind: connections.KindPostgres, CatalogName: "warehouse",
		Config: connections.ConnectionConfig{Postgres: &connections.PostgresConfig{
			Host: "localhost", Port: 5432, Database: "analytics", Username: "reader", SSLMode: "require",
			ConnectTimeoutSeconds: 10, PoolSize: 4,
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	active := "external:orders"
	session := models.ProjectSession{
		Version:   models.ProjectSessionVersion,
		Documents: []models.SQLDocument{},
		Tabs: []models.ProjectTabReference{{
			ID: active, Kind: models.ProjectTabKindExternal, Title: "Orders", ConnectionID: connection.ID,
			RelationID: "stale-client-id", Catalog: connection.CatalogName, Schema: "sales", Relation: `Order "Lines"`, RelationType: "table",
		}},
		Groups:        []models.ProjectTabGroup{{ID: "group-a", TabIDs: []string{active}, ActiveTabID: &active}},
		Layout:        models.ProjectLayoutNode{Kind: models.ProjectLayoutKindGroup, GroupID: "group-a", Size: 100},
		ActiveGroupID: "group-a",
		History:       []models.QueryHistoryEntry{},
	}
	if err := ws.SaveSession(ctx, project.ID, session); err != nil {
		t.Fatal(err)
	}
	manager := jobs.NewManagerWithContext(ctx, 1, nil)
	defer manager.Shutdown(context.Background())
	app := &App{ctx: ctx, db: db, workspace: ws, connections: connectionService, jobs: manager}
	opened, err := app.OpenProject(project.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(opened.Session.Tabs) != 1 || opened.Session.Tabs[0].Kind != models.ProjectTabKindPlaceholder || opened.Session.Tabs[0].PlaceholderReason != "disconnected" {
		t.Fatalf("restored tab = %+v", opened.Session.Tabs)
	}
	if len(opened.ExternalRelations) != 1 || opened.ExternalRelations[0].QualifiedName != `"warehouse"."sales"."Order ""Lines"""` {
		t.Fatalf("restored relation = %+v", opened.ExternalRelations)
	}
}

func errorCodeForAppTest(err error) string {
	if appErr, ok := err.(*models.AppError); ok {
		return appErr.Code
	}
	return ""
}
