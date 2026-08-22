package query

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"

	"ducs-table/internal/database"
	"ducs-table/internal/federation"
)

func TestFederatedJoinMaterializesLocalResult(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	remotePath := filepath.Join(dir, "remote.duckdb")
	remote, err := database.OpenPath(ctx, remotePath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := remote.SQL().ExecContext(ctx, `CREATE SCHEMA public`); err != nil {
		t.Fatal(err)
	}
	if _, err := remote.SQL().ExecContext(ctx, `CREATE TABLE public.profiles(id INTEGER, segment VARCHAR)`); err != nil {
		t.Fatal(err)
	}
	if _, err := remote.SQL().ExecContext(ctx, `INSERT INTO public.profiles VALUES (1,'pro'),(2,'free')`); err != nil {
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
	if _, err := db.SQL().ExecContext(ctx, `CREATE TABLE data.customers(id INTEGER, name VARCHAR)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.SQL().ExecContext(ctx, `INSERT INTO data.customers VALUES (1,'Ada'),(3,'Grace')`); err != nil {
		t.Fatal(err)
	}
	session, err := federation.New(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close(nil)
	if err := session.WithMutation(ctx, func(conn *sql.Conn) error {
		_, execErr := conn.ExecContext(ctx, `ATTACH `+database.QuoteStringLiteral(remotePath)+` AS ext (READ_ONLY)`)
		return execErr
	}); err != nil {
		t.Fatal(err)
	}
	result, err := New(db, session).Run(ctx, `SELECT c.id, c.name, p.segment FROM data.customers c LEFT JOIN ext.public.profiles p ON p.id = c.id ORDER BY c.id`)
	if err != nil {
		t.Fatal(err)
	}
	if result.RowCount != 2 {
		t.Fatalf("result rows = %d", result.RowCount)
	}
	if err := session.WithMutation(ctx, func(conn *sql.Conn) error { _, execErr := conn.ExecContext(ctx, `DETACH ext`); return execErr }); err != nil {
		t.Fatal(err)
	}
	var count int64
	if err := db.SQL().QueryRowContext(ctx, "SELECT COUNT(*) FROM "+database.QuoteQualified("result", result.Source.SQLName)).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 2 {
		t.Fatalf("materialized result count = %d", count)
	}
}
