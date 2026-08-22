package federation

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"

	"ducs-table/internal/database"
)

func TestAttachmentVisibilityAcrossDuckDBConnectionsAndReservedSession(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	externalPath := filepath.Join(dir, "external.duckdb")
	external, err := database.OpenPath(ctx, externalPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := external.SQL().ExecContext(ctx, `CREATE SCHEMA public`); err != nil {
		t.Fatal(err)
	}
	if _, err := external.SQL().ExecContext(ctx, `CREATE TABLE public.items AS SELECT * FROM (VALUES (1),(2)) t(id)`); err != nil {
		t.Fatal(err)
	}
	if err := external.Close(); err != nil {
		t.Fatal(err)
	}
	workspaceDB, err := database.OpenPath(ctx, filepath.Join(dir, "workspace.duckdb"))
	if err != nil {
		t.Fatal(err)
	}
	defer workspaceDB.Close()
	session, err := New(ctx, workspaceDB)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close(func(conn *sql.Conn) { _, _ = conn.ExecContext(context.Background(), `DETACH ext`) })
	if err := session.WithMutation(ctx, func(conn *sql.Conn) error {
		_, execErr := conn.ExecContext(ctx, `ATTACH `+database.QuoteStringLiteral(externalPath)+` AS ext (READ_ONLY)`)
		return execErr
	}); err != nil {
		t.Fatal(err)
	}
	var reservedCount int
	if err := session.WithConn(ctx, func(conn *sql.Conn) error {
		return conn.QueryRowContext(ctx, `SELECT COUNT(*) FROM ext.public.items`).Scan(&reservedCount)
	}); err != nil {
		t.Fatal(err)
	}
	if reservedCount != 2 {
		t.Fatalf("reserved session count = %d", reservedCount)
	}
	// duckdb-go currently exposes the attachment to another connection from the
	// same database instance. This observation is deliberately not used by the
	// implementation: secret/extension state and future driver behavior can
	// still be connection-local, and all federated work above used Session.
	other, err := workspaceDB.SQL().Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	var otherCount int
	otherErr := other.QueryRowContext(ctx, `SELECT COUNT(*) FROM ext.public.items`).Scan(&otherCount)
	if otherErr == nil && otherCount != 2 {
		t.Fatalf("cross-connection visible count = %d", otherCount)
	}
	if otherErr != nil {
		t.Logf("attachments are connection-local in this duckdb-go build: %v", otherErr)
	} else {
		t.Log("attachments are database-instance-visible in this duckdb-go build; federated code still uses the reserved session")
	}
}
