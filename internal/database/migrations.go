package database

import (
	"context"
	"database/sql"
	"fmt"
)

var migrationStatements = []string{
	`CREATE SCHEMA IF NOT EXISTS ducs_meta`,
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
}

// Migrate applies the schema definition transactionally and is safe to run
// repeatedly.
func (d *DB) Migrate(ctx context.Context) error {
	if err := d.WithTx(ctx, func(tx *sql.Tx) error {
		for _, statement := range migrationStatements {
			if _, err := tx.ExecContext(ctx, statement); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		return fmt.Errorf("database migration: %w", err)
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
		return nil
	})
}
