// Package database owns the persistent DuckDB connection, migrations, catalog
// helpers, safe SQL quoting, and value serialization.
package database

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"path/filepath"
	"sync"
	"time"

	"ducs-table/internal/apppaths"

	duckdb "github.com/duckdb/duckdb-go/v2"
)

const maxOpenConnections = 4

// DB is the application's shared DuckDB database. Mutating service operations
// use WithMutation/WithTx so catalog publication is serialized.
type DB struct {
	sql       *sql.DB
	paths     apppaths.Paths
	mutation  chan struct{}
	closeOnce sync.Once
	closeErr  error
}

// Open creates a bounded DuckDB pool, initializes every connection's private
// temp/extension paths, applies idempotent migrations, and removes abandoned
// ephemeral state from an earlier process.
func Open(ctx context.Context, paths apppaths.Paths) (*DB, error) {
	if err := paths.Ensure(); err != nil {
		return nil, err
	}
	if paths.DBPath == "" {
		return nil, errors.New("database: empty database path")
	}

	initConnection := func(execer driver.ExecerContext) error {
		statements := []string{
			"SET temp_directory = " + QuoteStringLiteral(paths.TempDir),
			"SET extension_directory = " + QuoteStringLiteral(paths.ExtensionsDir),
			"SET autoinstall_known_extensions = false",
			"SET autoload_known_extensions = false",
		}
		for _, statement := range statements {
			if _, err := execer.ExecContext(context.Background(), statement, nil); err != nil {
				return fmt.Errorf("configure DuckDB connection: %w", err)
			}
		}
		return nil
	}

	connector, err := duckdb.NewConnector(paths.DBPath, initConnection)
	if err != nil {
		return nil, fmt.Errorf("open DuckDB connector: %w", err)
	}
	sqlDB := sql.OpenDB(connector)
	sqlDB.SetMaxOpenConns(maxOpenConnections)
	sqlDB.SetMaxIdleConns(maxOpenConnections)
	sqlDB.SetConnMaxIdleTime(10 * time.Minute)

	db := &DB{sql: sqlDB, paths: paths, mutation: make(chan struct{}, 1)}
	db.mutation <- struct{}{}
	if err := sqlDB.PingContext(ctx); err != nil {
		_ = sqlDB.Close()
		return nil, fmt.Errorf("ping DuckDB: %w", err)
	}
	if err := db.Migrate(ctx); err != nil {
		_ = db.Close()
		return nil, err
	}
	if err := db.CleanupStartup(ctx); err != nil {
		_ = db.Close()
		return nil, err
	}
	return db, nil
}

// OpenPath is a convenience for tests and command-line integrations. Runtime
// applications should normally resolve paths with apppaths.Resolve first.
func OpenPath(ctx context.Context, dbPath string) (*DB, error) {
	if dbPath == "" {
		return nil, errors.New("database: empty database path")
	}
	absDBPath, err := filepath.Abs(dbPath)
	if err != nil {
		return nil, fmt.Errorf("database: resolve database path: %w", err)
	}
	base := filepath.Dir(absDBPath)
	paths, err := apppaths.ResolveAt(base)
	if err != nil {
		return nil, err
	}
	paths.DBPath = filepath.Clean(absDBPath)
	return Open(ctx, paths)
}

func (d *DB) SQL() *sql.DB            { return d.sql }
func (d *DB) Paths() apppaths.Paths   { return d.paths }
func (d *DB) MaxOpenConnections() int { return maxOpenConnections }
func (d *DB) acquire(ctx context.Context) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-d.mutation:
		return nil
	}
}

func (d *DB) release() { d.mutation <- struct{}{} }

// WithMutation runs fn on one checked-out connection while holding the global
// catalog mutation lock. The callback must not retain the connection.
func (d *DB) WithMutation(ctx context.Context, fn func(*sql.Conn) error) error {
	if err := d.acquire(ctx); err != nil {
		return err
	}
	defer d.release()
	conn, err := d.sql.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	return fn(conn)
}

// WithTx serializes a transaction and handles rollback on every error path.
func (d *DB) WithTx(ctx context.Context, fn func(*sql.Tx) error) error {
	return d.WithMutation(ctx, func(conn *sql.Conn) error {
		tx, err := conn.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		committed := false
		defer func() {
			if !committed {
				_ = tx.Rollback()
			}
		}()
		if err := fn(tx); err != nil {
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
		committed = true
		return nil
	})
}

func (d *DB) Close() error {
	d.closeOnce.Do(func() { d.closeErr = d.sql.Close() })
	return d.closeErr
}
