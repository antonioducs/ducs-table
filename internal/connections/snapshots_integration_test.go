package connections

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"ducs-table/internal/credentials"
	"ducs-table/internal/database"
	"ducs-table/internal/extensions"
	"ducs-table/internal/federation"
	"ducs-table/internal/models"
	"ducs-table/internal/workspace"
)

func TestSnapshotCreateRefreshCancellationAndConnectionDeletion(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	externalPath := filepath.Join(dir, "remote.duckdb")
	remote, err := database.OpenPath(ctx, externalPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := remote.SQL().ExecContext(ctx, `CREATE SCHEMA public`); err != nil {
		t.Fatal(err)
	}
	if _, err := remote.SQL().ExecContext(ctx, `CREATE TABLE public.people(id INTEGER PRIMARY KEY, name VARCHAR)`); err != nil {
		t.Fatal(err)
	}
	if _, err := remote.SQL().ExecContext(ctx, `INSERT INTO public.people VALUES (1,'Ada'),(2,'Linus')`); err != nil {
		t.Fatal(err)
	}
	if err := remote.Close(); err != nil {
		t.Fatal(err)
	}
	db, err := database.OpenPath(ctx, filepath.Join(dir, "workspace.duckdb"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ws := workspace.New(db)
	projectA, err := ws.InitialProject(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if projectA.Name != "My Workspace" {
		t.Fatalf("initial project = %q, want My Workspace", projectA.Name)
	}
	projectB, err := ws.CreateProject(ctx, "Project B", "")
	if err != nil {
		t.Fatal(err)
	}
	session, err := federation.New(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	service := NewService(db, session, credentials.NewMemoryStore(), extensions.NewManager(), ws, nil)
	defer service.Shutdown()
	info := validPostgresInfo()
	info.ID = "snapshot-connection"
	info.CatalogName = "ext"
	now := time.Now().UTC()
	info.CreatedAt = now
	info.UpdatedAt = now
	if err := service.repo.Create(ctx, projectA.ID, info); err != nil {
		t.Fatal(err)
	}
	attach := func() {
		t.Helper()
		if err := session.WithMutation(ctx, func(conn *sql.Conn) error {
			_, execErr := conn.ExecContext(ctx, `ATTACH `+database.QuoteStringLiteral(externalPath)+` AS ext (READ_ONLY)`)
			if execErr == nil {
				session.MarkAttached(info.ID, info.CatalogName)
			}
			return execErr
		}); err != nil {
			t.Fatal(err)
		}
	}
	attach()
	service.setRuntime(info.ID, runtimeState{status: StatusConnected})
	relations, err := service.ListRelations(ctx, ListRelationsRequest{ProjectID: projectA.ID, ConnectionID: info.ID, Schema: "public"})
	if err != nil {
		t.Fatal(err)
	}
	if len(relations) != 1 {
		t.Fatalf("relations = %d", len(relations))
	}
	relation, err := service.GetExternalRelation(ctx, projectA.ID, relations[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := service.CreateSnapshot(ctx, SnapshotRequest{ProjectID: projectA.ID, RelationID: relation.ID, DisplayName: "People snapshot"})
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.ProjectID != projectA.ID || snapshot.RowCount != 2 || snapshot.Snapshot == nil {
		t.Fatalf("unexpected snapshot: %+v", snapshot)
	}
	_, err = service.CreateSnapshot(ctx, SnapshotRequest{ProjectID: projectB.ID, RelationID: relation.ID, DisplayName: "Cross-project snapshot"})
	var appErr *models.AppError
	if !errors.As(err, &appErr) || appErr.Code != models.CodeConnectionNotFound {
		t.Fatalf("cross-project snapshot create error = %#v, want %s", err, models.CodeConnectionNotFound)
	}
	_, err = service.RefreshSnapshot(ctx, projectB.ID, snapshot.ID)
	if !errors.As(err, &appErr) || appErr.Code != models.CodeNotFound {
		t.Fatalf("cross-project snapshot refresh error = %#v, want %s", err, models.CodeNotFound)
	}
	if err := session.WithMutation(ctx, func(conn *sql.Conn) error {
		_, execErr := conn.ExecContext(ctx, `DETACH ext`)
		if execErr == nil {
			session.MarkDetached(info.ID)
		}
		return execErr
	}); err != nil {
		t.Fatal(err)
	}
	remote, err = database.OpenPath(ctx, externalPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := remote.SQL().ExecContext(ctx, `INSERT INTO public.people VALUES (3,'Grace')`); err != nil {
		t.Fatal(err)
	}
	if err := remote.Close(); err != nil {
		t.Fatal(err)
	}
	attach()
	refreshed, err := service.RefreshSnapshot(ctx, projectA.ID, snapshot.ID)
	if err != nil {
		t.Fatal(err)
	}
	if refreshed.RowCount != 3 {
		t.Fatalf("refreshed count = %d", refreshed.RowCount)
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := service.RefreshSnapshot(cancelled, projectA.ID, snapshot.ID); err == nil {
		t.Fatal("cancelled refresh succeeded")
	}
	preserved, err := ws.GetSource(ctx, projectA.ID, snapshot.ID)
	if err != nil {
		t.Fatal(err)
	}
	if preserved.RowCount != 3 {
		t.Fatalf("cancelled refresh changed snapshot count to %d", preserved.RowCount)
	}
	if err := service.DeleteConnection(ctx, info.ID); err != nil {
		t.Fatal(err)
	}
	preserved, err = ws.GetSource(ctx, projectA.ID, snapshot.ID)
	if err != nil {
		t.Fatal(err)
	}
	if preserved.Snapshot == nil || preserved.Snapshot.ConnectionID != nil {
		t.Fatalf("deleted connection was not detached from snapshot metadata: %+v", preserved.Snapshot)
	}
	var physicalCount int64
	if err := db.SQL().QueryRowContext(ctx, "SELECT COUNT(*) FROM "+database.QuoteQualified("data", preserved.SQLName)).Scan(&physicalCount); err != nil {
		t.Fatal(err)
	}
	if physicalCount != 3 {
		t.Fatalf("local snapshot data was not preserved: %d", physicalCount)
	}
}
