package database

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"ducs-table/internal/models"
)

const emptyProjectSessionJSON = `{"version":1,"sqlDraft":"","tabs":[],"history":[],"resultSequence":0}`

type migration struct {
	version int
	apply   func(context.Context, *sql.Tx) error
}

var migrations = []migration{
	{version: 1, apply: applyV1},
	{version: 2, apply: applyV2},
	{version: 3, apply: applyV3},
	{version: 4, apply: applyV4},
	{version: 5, apply: applyV5},
}

// Migrate upgrades the database in one transaction. A database created by an
// older release has no schema_migrations table; its existing V1 tables are
// adopted by the idempotent V1 statements before V2 is applied.
func (d *DB) Migrate(ctx context.Context) error {
	err := d.WithTx(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `CREATE SCHEMA IF NOT EXISTS ducs_meta`); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `
			CREATE TABLE IF NOT EXISTS ducs_meta.schema_migrations (
				version INTEGER PRIMARY KEY,
				applied_at TIMESTAMPTZ NOT NULL
			)`); err != nil {
			return err
		}

		applied := make(map[int]bool)
		rows, err := tx.QueryContext(ctx, `SELECT version FROM ducs_meta.schema_migrations`)
		if err != nil {
			return err
		}
		for rows.Next() {
			var version int
			if err := rows.Scan(&version); err != nil {
				_ = rows.Close()
				return err
			}
			applied[version] = true
		}
		if err := rows.Err(); err != nil {
			_ = rows.Close()
			return err
		}
		if err := rows.Close(); err != nil {
			return err
		}

		for _, item := range migrations {
			if applied[item.version] {
				continue
			}
			if err := item.apply(ctx, tx); err != nil {
				return fmt.Errorf("apply schema version %d: %w", item.version, err)
			}
			if _, err := tx.ExecContext(ctx, `INSERT INTO ducs_meta.schema_migrations (version, applied_at) VALUES (?, ?)`, item.version, time.Now().UTC()); err != nil {
				return fmt.Errorf("record schema version %d: %w", item.version, err)
			}
		}
		return nil
	})
	if err != nil {
		return fmt.Errorf("database migration: %w", err)
	}
	return nil
}

func applyV1(ctx context.Context, tx *sql.Tx) error {
	statements := []string{
		`CREATE SCHEMA IF NOT EXISTS data`,
		`CREATE SCHEMA IF NOT EXISTS result`,
		`CREATE TABLE IF NOT EXISTS ducs_meta.datasets (
			id VARCHAR PRIMARY KEY,
			display_name VARCHAR NOT NULL,
			sql_name VARCHAR NOT NULL,
			schema_name VARCHAR NOT NULL CHECK (schema_name IN ('data', 'result')),
			source_type VARCHAR NOT NULL,
			source_path VARCHAR,
			sheet_name VARCHAR,
			row_count BIGINT NOT NULL DEFAULT 0,
			is_ephemeral BOOLEAN NOT NULL DEFAULT FALSE,
			original_query VARCHAR,
			created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
			UNIQUE (schema_name, sql_name)
		)`,
		`CREATE TABLE IF NOT EXISTS ducs_meta.saved_queries (
			id VARCHAR PRIMARY KEY,
			name VARCHAR NOT NULL UNIQUE,
			sql VARCHAR NOT NULL,
			created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
		)`,
		`CREATE TABLE IF NOT EXISTS ducs_meta.connections (
			id VARCHAR PRIMARY KEY,
			name VARCHAR NOT NULL,
			kind VARCHAR NOT NULL CHECK (kind IN ('postgres', 'mongo')),
			catalog_name VARCHAR NOT NULL UNIQUE,
			config_json VARCHAR NOT NULL,
			auto_connect BOOLEAN NOT NULL DEFAULT FALSE,
			created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
		)`,
		`CREATE TABLE IF NOT EXISTS ducs_meta.snapshots (
			source_id VARCHAR PRIMARY KEY,
			connection_id VARCHAR,
			connection_name VARCHAR NOT NULL,
			catalog_name VARCHAR NOT NULL,
			schema_name VARCHAR NOT NULL,
			relation_name VARCHAR NOT NULL,
			relation_type VARCHAR NOT NULL,
			refreshed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
		)`,
	}
	for _, statement := range statements {
		if _, err := tx.ExecContext(ctx, statement); err != nil {
			return err
		}
	}
	return nil
}

func applyV2(ctx context.Context, tx *sql.Tx) error {
	projectID, err := models.NewID()
	if err != nil {
		return fmt.Errorf("generate legacy project id: %w", err)
	}
	now := time.Now().UTC()

	statements := []string{
		`CREATE TABLE ducs_meta.projects (
			id VARCHAR PRIMARY KEY,
			name VARCHAR NOT NULL CHECK (name = trim(name) AND length(name) BETWEEN 1 AND 200),
			description VARCHAR NOT NULL DEFAULT '' CHECK (length(description) <= 1000),
			archived_at TIMESTAMPTZ,
			last_opened_at TIMESTAMPTZ,
			created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
		)`,
		`CREATE UNIQUE INDEX projects_name_nocase_uq ON ducs_meta.projects (lower(name))`,
		`CREATE TABLE ducs_meta.project_connections (
			project_id VARCHAR NOT NULL,
			connection_id VARCHAR NOT NULL,
			created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
			PRIMARY KEY (project_id, connection_id)
		)`,
		`CREATE TABLE ducs_meta.project_sessions (
			project_id VARCHAR PRIMARY KEY,
			state_json VARCHAR NOT NULL,
			updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
		)`,
	}
	for _, statement := range statements {
		if _, err := tx.ExecContext(ctx, statement); err != nil {
			return err
		}
	}

	if _, err := tx.ExecContext(ctx, `
		INSERT INTO ducs_meta.projects (
			id, name, description, archived_at, last_opened_at, created_at, updated_at
		) VALUES (?, 'My Workspace', '', NULL, ?, ?, ?)`, projectID, now, now, now); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO ducs_meta.project_connections (project_id, connection_id, created_at)
		SELECT ?, id, created_at FROM ducs_meta.connections`, projectID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO ducs_meta.project_sessions (project_id, state_json, updated_at) VALUES (?, ?, ?)`, projectID, emptyProjectSessionJSON, now); err != nil {
		return err
	}

	if err := rebuildDatasetsV2(ctx, tx, projectID); err != nil {
		return err
	}
	if err := rebuildSavedQueriesV2(ctx, tx, projectID); err != nil {
		return err
	}
	return nil
}

func rebuildDatasetsV2(ctx context.Context, tx *sql.Tx, projectID string) error {
	statements := []string{
		`CREATE TABLE ducs_meta.datasets_v2 (
			id VARCHAR PRIMARY KEY,
			project_id VARCHAR NOT NULL,
			display_name VARCHAR NOT NULL,
			sql_name VARCHAR NOT NULL,
			schema_name VARCHAR NOT NULL CHECK (schema_name IN ('data', 'result')),
			source_type VARCHAR NOT NULL,
			source_path VARCHAR,
			sheet_name VARCHAR,
			row_count BIGINT NOT NULL DEFAULT 0,
			is_ephemeral BOOLEAN NOT NULL DEFAULT FALSE,
			original_query VARCHAR,
			created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
			UNIQUE (schema_name, sql_name)
		)`,
		`INSERT INTO ducs_meta.datasets_v2 (
			id, project_id, display_name, sql_name, schema_name, source_type,
			source_path, sheet_name, row_count, is_ephemeral, original_query,
			created_at, updated_at
		) SELECT id, ?, display_name, sql_name, schema_name, source_type,
			source_path, sheet_name, row_count, is_ephemeral, original_query,
			created_at, updated_at FROM ducs_meta.datasets`,
		`DROP TABLE ducs_meta.datasets`,
		`ALTER TABLE ducs_meta.datasets_v2 RENAME TO datasets`,
		`CREATE INDEX datasets_project_id_idx ON ducs_meta.datasets (project_id)`,
	}
	for _, statement := range statements {
		if _, err := tx.ExecContext(ctx, statement, migrationArgs(statement, projectID)...); err != nil {
			return fmt.Errorf("rebuild datasets: %w", err)
		}
	}
	return nil
}

func rebuildSavedQueriesV2(ctx context.Context, tx *sql.Tx, projectID string) error {
	statements := []string{
		`CREATE TABLE ducs_meta.saved_queries_v2 (
			id VARCHAR PRIMARY KEY,
			project_id VARCHAR NOT NULL,
			name VARCHAR NOT NULL CHECK (name = trim(name) AND length(name) BETWEEN 1 AND 200),
			sql VARCHAR NOT NULL,
			created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
		)`,
		`INSERT INTO ducs_meta.saved_queries_v2 (
			id, project_id, name, sql, created_at, updated_at
		) SELECT id, ?, name, sql, created_at, updated_at FROM ducs_meta.saved_queries`,
		`DROP TABLE ducs_meta.saved_queries`,
		`ALTER TABLE ducs_meta.saved_queries_v2 RENAME TO saved_queries`,
		`CREATE INDEX saved_queries_project_id_idx ON ducs_meta.saved_queries (project_id)`,
		`CREATE UNIQUE INDEX saved_queries_project_name_nocase_uq ON ducs_meta.saved_queries (project_id, lower(name))`,
	}
	for _, statement := range statements {
		if _, err := tx.ExecContext(ctx, statement, migrationArgs(statement, projectID)...); err != nil {
			return fmt.Errorf("rebuild saved queries: %w", err)
		}
	}
	return nil
}

// applyV3 repairs workspaces opened by an intermediate projects build whose
// V2 marker was recorded before the project timestamp columns were finalized.
// The small metadata tables are rebuilt because DuckDB 1.4.5 cannot safely
// replay ALTER COLUMN SET NOT NULL for a timestamp default from its WAL.
func applyV3(ctx context.Context, tx *sql.Tx) error {
	connectionTimestamp := "CURRENT_TIMESTAMP"
	hasConnectionTimestamp, err := migrationColumnExists(ctx, tx, "project_connections", "created_at")
	if err != nil {
		return err
	}
	if hasConnectionTimestamp {
		connectionTimestamp = "COALESCE(created_at, CURRENT_TIMESTAMP)"
	}
	sessionTimestamp := "CURRENT_TIMESTAMP"
	hasSessionTimestamp, err := migrationColumnExists(ctx, tx, "project_sessions", "updated_at")
	if err != nil {
		return err
	}
	if hasSessionTimestamp {
		sessionTimestamp = "COALESCE(updated_at, CURRENT_TIMESTAMP)"
	}
	statements := []string{
		`CREATE TABLE ducs_meta.project_connections_v3 (
			project_id VARCHAR NOT NULL,
			connection_id VARCHAR NOT NULL,
			created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
			PRIMARY KEY (project_id, connection_id)
		)`,
		fmt.Sprintf(`INSERT INTO ducs_meta.project_connections_v3 (project_id, connection_id, created_at)
			SELECT project_id, connection_id, %s FROM ducs_meta.project_connections`, connectionTimestamp),
		`DROP TABLE ducs_meta.project_connections`,
		`ALTER TABLE ducs_meta.project_connections_v3 RENAME TO project_connections`,
		`CREATE TABLE ducs_meta.project_sessions_v3 (
			project_id VARCHAR PRIMARY KEY,
			state_json VARCHAR NOT NULL,
			updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
		)`,
		fmt.Sprintf(`INSERT INTO ducs_meta.project_sessions_v3 (project_id, state_json, updated_at)
			SELECT project_id, state_json, %s FROM ducs_meta.project_sessions`, sessionTimestamp),
		`DROP TABLE ducs_meta.project_sessions`,
		`ALTER TABLE ducs_meta.project_sessions_v3 RENAME TO project_sessions`,
	}
	for _, statement := range statements {
		if _, err := tx.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("repair project timestamps: %w", err)
		}
	}
	return nil
}

// applyV4 adds the durable, project-scoped AI transcript. Provider
// credentials deliberately do not live in DuckDB: provider authentication is
// owned by the isolated sidecar profile.
func applyV4(ctx context.Context, tx *sql.Tx) error {
	statements := []string{
		`CREATE TABLE ducs_meta.ai_conversations (
			id VARCHAR PRIMARY KEY,
			project_id VARCHAR NOT NULL,
			title VARCHAR NOT NULL CHECK (title = trim(title) AND length(title) BETWEEN 1 AND 200),
			provider VARCHAR NOT NULL CHECK (provider IN ('codex', 'claude')),
			model VARCHAR NOT NULL,
			created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
		)`,
		`CREATE INDEX ai_conversations_project_updated_idx
			ON ducs_meta.ai_conversations (project_id, updated_at)`,
		`CREATE TABLE ducs_meta.ai_messages (
			id VARCHAR PRIMARY KEY,
			conversation_id VARCHAR NOT NULL,
			sequence BIGINT NOT NULL,
			role VARCHAR NOT NULL CHECK (role IN ('user', 'assistant', 'tool', 'system')),
			content VARCHAR NOT NULL DEFAULT '',
			reasoning VARCHAR NOT NULL DEFAULT '',
			status VARCHAR NOT NULL CHECK (status IN ('complete', 'streaming', 'interrupted', 'cancelled', 'error')),
			error VARCHAR NOT NULL DEFAULT '',
			metadata_json VARCHAR NOT NULL DEFAULT '{}',
			created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
			UNIQUE (conversation_id, sequence)
		)`,
		`CREATE INDEX ai_messages_conversation_sequence_idx
			ON ducs_meta.ai_messages (conversation_id, sequence)`,
		`CREATE TABLE ducs_meta.ai_provider_sessions (
			conversation_id VARCHAR NOT NULL,
			provider VARCHAR NOT NULL CHECK (provider IN ('codex', 'claude')),
			session_id VARCHAR NOT NULL,
			model VARCHAR NOT NULL,
			tool_signature VARCHAR NOT NULL,
			context_hash VARCHAR NOT NULL,
			account_fingerprint VARCHAR NOT NULL,
			created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
			PRIMARY KEY (conversation_id, provider)
		)`,
		`CREATE TABLE ducs_meta.ai_settings (
			project_id VARCHAR PRIMARY KEY,
			provider VARCHAR NOT NULL CHECK (provider IN ('codex', 'claude')),
			model VARCHAR NOT NULL,
			reasoning_effort VARCHAR NOT NULL DEFAULT '',
			consent BOOLEAN NOT NULL DEFAULT FALSE,
			updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
		)`,
		// This handles workspaces produced by prerelease V4 builds. Normal
		// startup repeats the reconciliation so every interrupted process is
		// repaired, not just the first process applying this migration.
		`UPDATE ducs_meta.ai_messages
			SET status = 'interrupted', error = 'Response interrupted when the application closed', updated_at = CURRENT_TIMESTAMP
			WHERE status = 'streaming'`,
	}
	for _, statement := range statements {
		if _, err := tx.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("create AI metadata: %w", err)
		}
	}
	return nil
}

func applyV5(ctx context.Context, tx *sql.Tx) error {
	statements := []string{
		`CREATE TABLE ducs_meta.ai_settings_v5 (
			project_id VARCHAR PRIMARY KEY,
			provider VARCHAR NOT NULL CHECK (provider IN ('codex', 'claude')),
			model VARCHAR NOT NULL,
			reasoning_effort VARCHAR NOT NULL DEFAULT '',
			consent BOOLEAN NOT NULL DEFAULT FALSE,
			fast_mode BOOLEAN NOT NULL DEFAULT FALSE,
			updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
		)`,
		`INSERT INTO ducs_meta.ai_settings_v5
			(project_id, provider, model, reasoning_effort, consent, fast_mode, updated_at)
		 SELECT project_id, provider, model, reasoning_effort, consent, FALSE, updated_at
		 FROM ducs_meta.ai_settings`,
		`DROP TABLE ducs_meta.ai_settings`,
		`ALTER TABLE ducs_meta.ai_settings_v5 RENAME TO ai_settings`,
	}
	for _, statement := range statements {
		if _, err := tx.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("rebuild AI settings for fast mode: %w", err)
		}
	}
	return nil
}

func migrationColumnExists(ctx context.Context, tx *sql.Tx, table, column string) (bool, error) {
	var exists bool
	err := tx.QueryRowContext(ctx, `SELECT EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_schema = 'ducs_meta' AND table_name = ? AND column_name = ?
	)`, table, column).Scan(&exists)
	if err != nil {
		return false, fmt.Errorf("inspect project migration column: %w", err)
	}
	return exists, nil
}

func migrationArgs(statement, projectID string) []any {
	for _, r := range statement {
		if r == '?' {
			return []any{projectID}
		}
	}
	return nil
}

// CleanupStartup removes all query-result tables/metadata and orphan import
// staging tables left by an interrupted process.
func (d *DB) CleanupStartup(ctx context.Context) error {
	return d.WithTx(ctx, func(tx *sql.Tx) error {
		type tableRef struct{ schema, name string }
		refs := make([]tableRef, 0)
		rows, err := tx.QueryContext(ctx, `
			SELECT table_schema, table_name
			FROM information_schema.tables
			WHERE table_type = 'BASE TABLE'
			  AND ((table_schema = 'result')
			       OR (table_schema = 'data' AND starts_with(table_name, '__staging_')))`)
		if err != nil {
			return fmt.Errorf("list startup cleanup tables: %w", err)
		}
		for rows.Next() {
			var ref tableRef
			if err := rows.Scan(&ref.schema, &ref.name); err != nil {
				_ = rows.Close()
				return err
			}
			refs = append(refs, ref)
		}
		if err := rows.Err(); err != nil {
			_ = rows.Close()
			return err
		}
		if err := rows.Close(); err != nil {
			return err
		}
		for _, ref := range refs {
			if _, err := tx.ExecContext(ctx, "DROP TABLE IF EXISTS "+QuoteQualified(ref.schema, ref.name)); err != nil {
				return fmt.Errorf("drop startup table: %w", err)
			}
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM ducs_meta.datasets WHERE is_ephemeral OR schema_name = 'result'`); err != nil {
			return fmt.Errorf("delete ephemeral metadata: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `
			UPDATE ducs_meta.ai_messages
			SET status = 'interrupted',
			    error = 'Response interrupted when the application closed',
			    updated_at = CURRENT_TIMESTAMP
			WHERE status = 'streaming'`); err != nil {
			return fmt.Errorf("reconcile interrupted AI messages: %w", err)
		}
		return nil
	})
}
