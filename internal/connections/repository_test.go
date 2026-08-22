package connections

import (
	"context"
	"database/sql"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"ducs-table/internal/credentials"
	"ducs-table/internal/database"
	"ducs-table/internal/extensions"
	"ducs-table/internal/federation"
	"ducs-table/internal/models"
	"ducs-table/internal/workspace"
)

func openConnectionTestDB(t *testing.T) (*database.DB, string) {
	t.Helper()
	ctx := context.Background()
	db, err := database.OpenPath(ctx, filepath.Join(t.TempDir(), "workspace.duckdb"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	project, err := workspace.New(db).InitialProject(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if project.Name != "My Workspace" {
		t.Fatalf("initial project = %q, want My Workspace", project.Name)
	}
	return db, project.ID
}

func TestRepositoryPersistsOnlySafeMetadataAndPreservesSnapshot(t *testing.T) {
	ctx := context.Background()
	db, projectA := openConnectionTestDB(t)
	ws := workspace.New(db)
	projectB, err := ws.CreateProject(ctx, "Project B", "")
	if err != nil {
		t.Fatal(err)
	}
	repo := NewRepository(db)
	info := validPostgresInfo()
	info.ID = "conn-1"
	info.CatalogName = "prod"
	now := time.Now().UTC()
	info.CreatedAt = now
	info.UpdatedAt = now
	if err := repo.Create(ctx, projectA, info); err != nil {
		t.Fatal(err)
	}
	if err := ws.AttachConnection(ctx, projectB.ID, info.ID); err != nil {
		t.Fatal(err)
	}
	var raw string
	if err := db.SQL().QueryRowContext(ctx, `SELECT config_json FROM ducs_meta.connections WHERE id = 'conn-1'`).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(strings.ToLower(raw), "password") {
		t.Fatalf("connection metadata contains a password field: %s", raw)
	}
	if err := repo.Create(ctx, projectA, ConnectionInfo{ID: "conn-2", Name: "Duplicate", Kind: KindPostgres, CatalogName: "prod", Config: info.Config, CreatedAt: now, UpdatedAt: now}); err == nil {
		t.Fatal("duplicate catalog alias was accepted")
	}
	if err := db.WithTx(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `CREATE TABLE data.snapshot_table AS SELECT 1 AS id`); err != nil {
			return err
		}
		source := models.SourceInfo{ID: "snapshot-1", ProjectID: projectA, DisplayName: "Snapshot", SQLName: "snapshot_table", Schema: "data", SourceType: "snapshot", RowCount: 1, CreatedAt: now, UpdatedAt: now}
		if err := workspace.InsertSourceTx(ctx, tx, projectA, source); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `INSERT INTO ducs_meta.snapshots VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, source.ID, info.ID, info.Name, info.CatalogName, "public", "people", "table", now)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if err := repo.Delete(ctx, info.ID); err != nil {
		t.Fatal(err)
	}
	var connectionID sql.NullString
	if err := db.SQL().QueryRowContext(ctx, `SELECT connection_id FROM ducs_meta.snapshots WHERE source_id = 'snapshot-1'`).Scan(&connectionID); err != nil {
		t.Fatal(err)
	}
	if connectionID.Valid {
		t.Fatal("snapshot retained deleted connection ID")
	}
	snapshot, err := ws.GetSource(ctx, projectA, "snapshot-1")
	if err != nil {
		t.Fatalf("local snapshot was deleted: %v", err)
	}
	if snapshot.ProjectID != projectA || snapshot.Snapshot == nil || snapshot.Snapshot.ConnectionID != nil {
		t.Fatalf("snapshot ownership/origin was not preserved: %+v", snapshot)
	}
	var links int
	if err := db.SQL().QueryRowContext(ctx, `SELECT COUNT(*) FROM ducs_meta.project_connections WHERE connection_id = ?`, info.ID).Scan(&links); err != nil {
		t.Fatal(err)
	}
	if links != 0 {
		t.Fatalf("global delete left %d project link(s)", links)
	}
	if _, err := repo.Get(ctx, info.ID); err == nil {
		t.Fatal("globally deleted connection is still readable")
	}
}

func TestConnectionSharingAndDetachPreserveCredentialAndRuntime(t *testing.T) {
	ctx := context.Background()
	db, projectA := openConnectionTestDB(t)
	ws := workspace.New(db)
	projectB, err := ws.CreateProject(ctx, "Project B", "")
	if err != nil {
		t.Fatal(err)
	}
	session, err := federation.New(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	store := credentials.NewMemoryStore()
	service := NewService(db, session, store, extensions.NewManager(), ws, nil)
	defer service.Shutdown()
	request := CreateConnectionRequest{
		ProjectID: projectA, Name: "Shared production", Kind: KindPostgres, CatalogName: "shared_prod",
		Config: validPostgresInfo().Config, Password: "one-credential", AutoConnect: true,
	}
	created, err := service.CreateConnection(ctx, request)
	if err != nil {
		t.Fatal(err)
	}
	if err := ws.AttachConnection(ctx, projectB.ID, created.ID); err != nil {
		t.Fatal(err)
	}
	if store.Len() != 1 {
		t.Fatalf("shared connection stored %d credentials, want 1", store.Len())
	}
	global, err := service.ListConnections(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(global) != 1 || global[0].ProjectCount != 2 {
		t.Fatalf("unexpected global connection usage: %+v", global)
	}
	for _, projectID := range []string{projectA, projectB.ID} {
		ids, err := ws.ListConnectionIDs(ctx, projectID)
		if err != nil {
			t.Fatal(err)
		}
		if len(ids) != 1 || ids[0] != created.ID {
			t.Fatalf("project %s connection IDs = %+v", projectID, ids)
		}
	}
	for _, projectID := range []string{projectA, projectB.ID} {
		ids, err := service.AutoConnectIDs(ctx, projectID)
		if err != nil || len(ids) != 1 || ids[0] != created.ID {
			t.Fatalf("project %s auto-connect IDs = %+v, err=%v", projectID, ids, err)
		}
	}

	service.setRuntime(created.ID, runtimeState{status: StatusConnected})
	if err := ws.DetachConnection(ctx, projectA, created.ID); err != nil {
		t.Fatal(err)
	}
	remaining, err := service.GetConnection(ctx, created.ID)
	if err != nil {
		t.Fatalf("detach deleted connection: %v", err)
	}
	if remaining.Status != StatusConnected || remaining.ProjectCount != 1 {
		t.Fatalf("detach changed shared runtime/usage: %+v", remaining)
	}
	if store.Len() != 1 {
		t.Fatalf("detach changed credential count to %d", store.Len())
	}
	itemsA, err := ws.ListConnectionIDs(ctx, projectA)
	if err != nil {
		t.Fatal(err)
	}
	itemsB, err := ws.ListConnectionIDs(ctx, projectB.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(itemsA) != 0 || len(itemsB) != 1 || itemsB[0] != created.ID {
		t.Fatalf("detach changed wrong project links: A=%+v B=%+v", itemsA, itemsB)
	}
	if ids, err := service.AutoConnectIDs(ctx, projectA); err != nil || len(ids) != 0 {
		t.Fatalf("detached project auto-connect IDs = %+v, err=%v", ids, err)
	}

	if err := service.DeleteConnection(ctx, created.ID); err != nil {
		t.Fatal(err)
	}
	if store.Len() != 0 {
		t.Fatalf("global delete left %d credential(s)", store.Len())
	}
	usage, err := ws.ConnectionUsageCount(ctx, created.ID)
	if err != nil {
		t.Fatal(err)
	}
	if usage != 0 {
		t.Fatalf("global delete left %d project link(s)", usage)
	}
}
