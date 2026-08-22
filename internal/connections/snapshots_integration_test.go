package connections

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
	"time"

	"ducs-table/internal/credentials"
	"ducs-table/internal/database"
	"ducs-table/internal/extensions"
	"ducs-table/internal/federation"
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
	session, err := federation.New(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	ws := workspace.New(db)
	service := NewService(db, session, credentials.NewMemoryStore(), extensions.NewManager(), ws, nil)
	defer service.Shutdown()
	info := validPostgresInfo()
	info.ID = "snapshot-connection"
	info.CatalogName = "ext"
	now := time.Now().UTC()
	info.CreatedAt = now
	info.UpdatedAt = now
	if err := service.repo.Create(ctx, info); err != nil {
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
	relations, err := service.ListRelations(ctx, ListRelationsRequest{ConnectionID: info.ID, Schema: "public"})
	if err != nil {
		t.Fatal(err)
	}
	if len(relations) != 1 {
		t.Fatalf("relations = %d", len(relations))
	}
	relation, err := service.GetExternalRelation(ctx, relations[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := service.CreateSnapshot(ctx, SnapshotRequest{RelationID: relation.ID, DisplayName: "People snapshot"})
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.RowCount != 2 || snapshot.Snapshot == nil {
		t.Fatalf("unexpected snapshot: %+v", snapshot)
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
	refreshed, err := service.RefreshSnapshot(ctx, snapshot.ID)
	if err != nil {
		t.Fatal(err)
	}
	if refreshed.RowCount != 3 {
		t.Fatalf("refreshed count = %d", refreshed.RowCount)
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := service.RefreshSnapshot(cancelled, snapshot.ID); err == nil {
		t.Fatal("cancelled refresh succeeded")
	}
	preserved, err := ws.GetSource(ctx, snapshot.ID)
	if err != nil {
		t.Fatal(err)
	}
	if preserved.RowCount != 3 {
		t.Fatalf("cancelled refresh changed snapshot count to %d", preserved.RowCount)
	}
	if err := service.DeleteConnection(ctx, info.ID); err != nil {
		t.Fatal(err)
	}
	preserved, err = ws.GetSource(ctx, snapshot.ID)
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
