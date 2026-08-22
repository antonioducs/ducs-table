package database

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	duckdb "github.com/duckdb/duckdb-go/v2"
)

func TestV2MigratesLegacyWorkspaceWithoutDataLoss(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "legacy.duckdb")
	raw := openRawDatabase(t, path)
	createLegacySchema(t, raw)
	createdAt := time.Date(2024, 3, 4, 5, 6, 7, 123000000, time.UTC)
	updatedAt := createdAt.Add(2 * time.Hour)
	refreshedAt := updatedAt.Add(time.Hour)

	statements := []struct {
		query string
		args  []any
	}{
		{query: `CREATE TABLE data.legacy_people AS SELECT 42 AS value`},
		{query: `INSERT INTO ducs_meta.connections (id, name, kind, catalog_name, config_json, auto_connect, created_at, updated_at) VALUES ('conn-1', 'Legacy DB', 'postgres', 'legacy_db', '{}', false, ?, ?)`, args: []any{createdAt, updatedAt}},
		{query: `INSERT INTO ducs_meta.datasets (id, display_name, sql_name, schema_name, source_type, source_path, row_count, is_ephemeral, created_at, updated_at) VALUES ('source-1', 'People', 'legacy_people', 'data', 'csv', '/old/people.csv', 1, false, ?, ?)`, args: []any{createdAt, updatedAt}},
		{query: `INSERT INTO ducs_meta.saved_queries (id, name, sql, created_at, updated_at) VALUES ('query-1', 'People query', 'SELECT * FROM data.legacy_people', ?, ?)`, args: []any{createdAt, updatedAt}},
		{query: `INSERT INTO ducs_meta.snapshots (source_id, connection_id, connection_name, catalog_name, schema_name, relation_name, relation_type, refreshed_at) VALUES ('source-1', 'conn-1', 'Legacy DB', 'legacy_db', 'public', 'people', 'table', ?)`, args: []any{refreshedAt}},
	}
	for _, statement := range statements {
		if _, err := raw.ExecContext(ctx, statement.query, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
	if err := raw.Close(); err != nil {
		t.Fatal(err)
	}

	db, err := OpenPath(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	var projectID, projectName, stateJSON string
	if err := db.SQL().QueryRowContext(ctx, `SELECT id, name FROM ducs_meta.projects`).Scan(&projectID, &projectName); err != nil {
		t.Fatal(err)
	}
	if projectName != "My Workspace" {
		t.Fatalf("project name = %q", projectName)
	}
	if err := db.SQL().QueryRowContext(ctx, `SELECT state_json FROM ducs_meta.project_sessions WHERE project_id = ?`, projectID).Scan(&stateJSON); err != nil {
		t.Fatal(err)
	}
	if stateJSON != emptyProjectSessionJSON {
		t.Fatalf("legacy session = %s", stateJSON)
	}

	var sourceProject, sourcePath string
	var sourceCreated, sourceUpdated time.Time
	if err := db.SQL().QueryRowContext(ctx, `SELECT project_id, source_path, created_at, updated_at FROM ducs_meta.datasets WHERE id = 'source-1'`).Scan(&sourceProject, &sourcePath, &sourceCreated, &sourceUpdated); err != nil {
		t.Fatal(err)
	}
	if sourceProject != projectID || sourcePath != "/old/people.csv" || !sourceCreated.Equal(createdAt) || !sourceUpdated.Equal(updatedAt) {
		t.Fatalf("dataset was not preserved: project=%q path=%q created=%v updated=%v", sourceProject, sourcePath, sourceCreated, sourceUpdated)
	}
	var queryProject string
	var queryCreated, queryUpdated time.Time
	if err := db.SQL().QueryRowContext(ctx, `SELECT project_id, created_at, updated_at FROM ducs_meta.saved_queries WHERE id = 'query-1'`).Scan(&queryProject, &queryCreated, &queryUpdated); err != nil {
		t.Fatal(err)
	}
	if queryProject != projectID || !queryCreated.Equal(createdAt) || !queryUpdated.Equal(updatedAt) {
		t.Fatalf("saved query was not preserved: project=%q created=%v updated=%v", queryProject, queryCreated, queryUpdated)
	}
	var value int
	if err := db.SQL().QueryRowContext(ctx, `SELECT value FROM data.legacy_people`).Scan(&value); err != nil || value != 42 {
		t.Fatalf("physical table value=%d err=%v", value, err)
	}
	var linked, snapshots int
	var linkCreated time.Time
	if err := db.SQL().QueryRowContext(ctx, `SELECT COUNT(*), min(created_at) FROM ducs_meta.project_connections WHERE project_id = ? AND connection_id = 'conn-1'`, projectID).Scan(&linked, &linkCreated); err != nil {
		t.Fatal(err)
	}
	if err := db.SQL().QueryRowContext(ctx, `SELECT COUNT(*) FROM ducs_meta.snapshots WHERE source_id = 'source-1' AND refreshed_at = ?`, refreshedAt).Scan(&snapshots); err != nil {
		t.Fatal(err)
	}
	if linked != 1 || !linkCreated.Equal(createdAt) || snapshots != 1 {
		t.Fatalf("linked=%d linkCreated=%v snapshots=%d", linked, linkCreated, snapshots)
	}

	if err := db.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	var projects, versions int
	if err := db.SQL().QueryRowContext(ctx, `SELECT COUNT(*) FROM ducs_meta.projects`).Scan(&projects); err != nil {
		t.Fatal(err)
	}
	if err := db.SQL().QueryRowContext(ctx, `SELECT COUNT(*) FROM ducs_meta.schema_migrations`).Scan(&versions); err != nil {
		t.Fatal(err)
	}
	if projects != 1 || versions != 3 {
		t.Fatalf("idempotent migration projects=%d versions=%d", projects, versions)
	}
}

func TestV3RepairsIntermediateProjectTimestampColumns(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "intermediate-v2.duckdb")
	createIntermediateV2Schema(t, path)

	db, err := OpenPath(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	assertRepairedProjectTimestamps(t, db)
	if _, err := db.SQL().ExecContext(ctx, `
		INSERT INTO ducs_meta.projects (id, name) VALUES ('repair-project', 'Repair Project');
		INSERT INTO ducs_meta.project_sessions (project_id, state_json) VALUES ('repair-project', ?);`, emptyProjectSessionJSON); err != nil {
		t.Fatal(err)
	}
	var updatedAt time.Time
	if err := db.SQL().QueryRowContext(ctx, `SELECT updated_at FROM ducs_meta.project_sessions WHERE project_id = 'repair-project'`).Scan(&updatedAt); err != nil {
		t.Fatal(err)
	}
	if updatedAt.IsZero() {
		t.Fatal("repaired session timestamp was not populated")
	}
}

func TestV3MigrationWALSurvivesUncleanExit(t *testing.T) {
	path := filepath.Join(t.TempDir(), "intermediate-v2-crash.duckdb")
	createIntermediateV2Schema(t, path)
	command := exec.Command(os.Args[0], "-test.run=^TestV3MigrationCrashHelper$")
	command.Env = append(os.Environ(), "DUCS_V3_CRASH_HELPER_PATH="+path)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("migration helper failed: %v\n%s", err, output)
	}
	db, err := OpenPath(context.Background(), path)
	if err != nil {
		t.Fatalf("replay repaired migration WAL: %v", err)
	}
	defer db.Close()
	assertRepairedProjectTimestamps(t, db)
}

func TestV3MigrationCrashHelper(t *testing.T) {
	path := os.Getenv("DUCS_V3_CRASH_HELPER_PATH")
	if path == "" {
		t.Skip("subprocess helper")
	}
	if _, err := OpenPath(context.Background(), path); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	os.Exit(0)
}

func createIntermediateV2Schema(t *testing.T, path string) {
	t.Helper()
	ctx := context.Background()
	raw := openRawDatabase(t, path)
	createLegacySchema(t, raw)
	tx, err := raw.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := applyV2(ctx, tx); err != nil {
		_ = tx.Rollback()
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	statements := []string{
		`ALTER TABLE ducs_meta.project_connections DROP COLUMN created_at`,
		`ALTER TABLE ducs_meta.project_sessions DROP COLUMN updated_at`,
		`CREATE TABLE ducs_meta.schema_migrations (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL)`,
		`INSERT INTO ducs_meta.schema_migrations VALUES (1, CURRENT_TIMESTAMP), (2, CURRENT_TIMESTAMP)`,
	}
	for _, statement := range statements {
		if _, err := raw.ExecContext(ctx, statement); err != nil {
			_ = raw.Close()
			t.Fatal(err)
		}
	}
	if err := raw.Close(); err != nil {
		t.Fatal(err)
	}
}

func assertRepairedProjectTimestamps(t *testing.T, db *DB) {
	t.Helper()
	ctx := context.Background()
	for _, item := range []struct{ table, column string }{
		{table: "project_connections", column: "created_at"},
		{table: "project_sessions", column: "updated_at"},
	} {
		var nullable string
		if err := db.SQL().QueryRowContext(ctx, `
			SELECT is_nullable FROM information_schema.columns
			WHERE table_schema = 'ducs_meta' AND table_name = ? AND column_name = ?`, item.table, item.column).Scan(&nullable); err != nil {
			t.Fatal(err)
		}
		if nullable != "NO" {
			t.Fatalf("%s.%s nullable = %q", item.table, item.column, nullable)
		}
	}
	var versionCount int
	if err := db.SQL().QueryRowContext(ctx, `SELECT COUNT(*) FROM ducs_meta.schema_migrations WHERE version = 3`).Scan(&versionCount); err != nil {
		t.Fatal(err)
	}
	if versionCount != 1 {
		t.Fatalf("V3 migration count = %d", versionCount)
	}
}

func TestV2MigrationRollsBackCompletelyOnFailure(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "invalid-legacy.duckdb")
	raw := openRawDatabase(t, path)
	createLegacySchema(t, raw)
	if _, err := raw.ExecContext(ctx, `INSERT INTO ducs_meta.saved_queries (id, name, sql) VALUES ('one', 'Report', 'SELECT 1'), ('two', 'report', 'SELECT 2')`); err != nil {
		t.Fatal(err)
	}
	if err := raw.Close(); err != nil {
		t.Fatal(err)
	}

	if db, err := OpenPath(ctx, path); err == nil {
		_ = db.Close()
		t.Fatal("migration with a case-insensitive legacy conflict succeeded")
	}

	raw = openRawDatabase(t, path)
	defer raw.Close()
	var projectsExist, migrationTableExists, projectColumnExists bool
	if err := raw.QueryRowContext(ctx, `SELECT EXISTS (
		SELECT 1 FROM information_schema.tables WHERE table_schema = 'ducs_meta' AND table_name = 'projects'
	)`).Scan(&projectsExist); err != nil {
		t.Fatal(err)
	}
	if err := raw.QueryRowContext(ctx, `SELECT EXISTS (
		SELECT 1 FROM information_schema.tables WHERE table_schema = 'ducs_meta' AND table_name = 'schema_migrations'
	)`).Scan(&migrationTableExists); err != nil {
		t.Fatal(err)
	}
	if err := raw.QueryRowContext(ctx, `SELECT EXISTS (
		SELECT 1 FROM information_schema.columns WHERE table_schema = 'ducs_meta' AND table_name = 'saved_queries' AND column_name = 'project_id'
	)`).Scan(&projectColumnExists); err != nil {
		t.Fatal(err)
	}
	if projectsExist || migrationTableExists || projectColumnExists {
		t.Fatalf("failed migration leaked state: projects=%v migrations=%v projectColumn=%v", projectsExist, migrationTableExists, projectColumnExists)
	}
	var rows int
	if err := raw.QueryRowContext(ctx, `SELECT COUNT(*) FROM ducs_meta.saved_queries`).Scan(&rows); err != nil || rows != 2 {
		t.Fatalf("legacy rows=%d err=%v", rows, err)
	}
}

func openRawDatabase(t *testing.T, path string) *sql.DB {
	t.Helper()
	connector, err := duckdb.NewConnector(path, nil)
	if err != nil {
		t.Fatal(err)
	}
	db := sql.OpenDB(connector)
	if err := db.Ping(); err != nil {
		_ = db.Close()
		t.Fatal(err)
	}
	return db
}

func createLegacySchema(t *testing.T, db *sql.DB) {
	t.Helper()
	ctx := context.Background()
	if _, err := db.ExecContext(ctx, `CREATE SCHEMA ducs_meta`); err != nil {
		t.Fatal(err)
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := applyV1(ctx, tx); err != nil {
		_ = tx.Rollback()
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
}
