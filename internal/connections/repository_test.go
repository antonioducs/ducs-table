package connections

import (
	"context"
	"database/sql"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"ducs-table/internal/database"
	"ducs-table/internal/models"
	"ducs-table/internal/workspace"
)

func openConnectionTestDB(t *testing.T) *database.DB {
	t.Helper()
	db, err := database.OpenPath(context.Background(), filepath.Join(t.TempDir(), "workspace.duckdb"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func TestRepositoryPersistsOnlySafeMetadataAndPreservesSnapshot(t *testing.T) {
	ctx := context.Background()
	db := openConnectionTestDB(t)
	repo := NewRepository(db)
	info := validPostgresInfo()
	info.ID = "conn-1"
	info.CatalogName = "prod"
	now := time.Now().UTC()
	info.CreatedAt = now
	info.UpdatedAt = now
	if err := repo.Create(ctx, info); err != nil {
		t.Fatal(err)
	}
	var raw string
	if err := db.SQL().QueryRowContext(ctx, `SELECT config_json FROM ducs_meta.connections WHERE id = 'conn-1'`).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(strings.ToLower(raw), "password") {
		t.Fatalf("connection metadata contains a password field: %s", raw)
	}
	if err := repo.Create(ctx, ConnectionInfo{ID: "conn-2", Name: "Duplicate", Kind: KindPostgres, CatalogName: "prod", Config: info.Config, CreatedAt: now, UpdatedAt: now}); err == nil {
		t.Fatal("duplicate catalog alias was accepted")
	}
	if err := db.WithTx(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `CREATE TABLE data.snapshot_table AS SELECT 1 AS id`); err != nil {
			return err
		}
		source := models.SourceInfo{ID: "snapshot-1", DisplayName: "Snapshot", SQLName: "snapshot_table", Schema: "data", SourceType: "snapshot", RowCount: 1, CreatedAt: now, UpdatedAt: now}
		if err := workspace.InsertSourceTx(ctx, tx, source); err != nil {
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
	if _, err := workspace.New(db).GetSource(ctx, "snapshot-1"); err != nil {
		t.Fatalf("local snapshot was deleted: %v", err)
	}
}
