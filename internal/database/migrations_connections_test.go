package database

import (
	"context"
	"path/filepath"
	"testing"
)

func TestConnectionMigrationsApplyToEmptyAndLegacyWorkspace(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "workspace.duckdb")
	db, err := OpenPath(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"connections", "snapshots"} {
		var exists bool
		if err := db.SQL().QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='ducs_meta' AND table_name=?)`, table).Scan(&exists); err != nil || !exists {
			t.Fatalf("empty migration table %s: exists=%v err=%v", table, exists, err)
		}
	}
	if _, err := db.SQL().ExecContext(ctx, `CREATE TABLE data.legacy_table AS SELECT 42 AS value`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.SQL().ExecContext(ctx, `INSERT INTO ducs_meta.datasets (id,display_name,sql_name,schema_name,source_type,row_count,is_ephemeral) VALUES ('legacy','Legacy','legacy_table','data','csv',1,false)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.SQL().ExecContext(ctx, `DROP TABLE ducs_meta.snapshots`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.SQL().ExecContext(ctx, `DROP TABLE ducs_meta.connections`); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	db, err = OpenPath(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var value int
	if err := db.SQL().QueryRowContext(ctx, `SELECT value FROM data.legacy_table`).Scan(&value); err != nil {
		t.Fatal(err)
	}
	if value != 42 {
		t.Fatalf("legacy value = %d", value)
	}
	var datasets int
	if err := db.SQL().QueryRowContext(ctx, `SELECT COUNT(*) FROM ducs_meta.datasets WHERE id='legacy'`).Scan(&datasets); err != nil {
		t.Fatal(err)
	}
	if datasets != 1 {
		t.Fatal("legacy metadata was not preserved")
	}
}
