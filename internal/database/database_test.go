package database

import (
	"context"
	"math/big"
	"path/filepath"
	"testing"

	"ducs-table/internal/apppaths"

	duckdb "github.com/duckdb/duckdb-go/v2"
)

func testDatabase(t *testing.T) *DB {
	t.Helper()
	paths, err := apppaths.ResolveAt(filepath.Join(t.TempDir(), "Duc's Table state"))
	if err != nil {
		t.Fatal(err)
	}
	db, err := Open(context.Background(), paths)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func TestMigrationsAreIdempotent(t *testing.T) {
	db := testDatabase(t)
	ctx := context.Background()
	if err := db.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	if err := db.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	for _, schema := range []string{"ducs_meta", "data", "result"} {
		var exists bool
		if err := db.SQL().QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = ?)`, schema).Scan(&exists); err != nil {
			t.Fatal(err)
		}
		if !exists {
			t.Fatalf("schema %q does not exist", schema)
		}
	}
	for _, table := range []string{"datasets", "saved_queries"} {
		exists, err := TableExists(ctx, db.SQL(), "ducs_meta", table)
		if err != nil {
			t.Fatal(err)
		}
		if !exists {
			t.Fatalf("table %q does not exist", table)
		}
	}
}

func TestQuoteNormalizeAndCollision(t *testing.T) {
	if got, want := QuoteIdentifier(`a"b`), `"a""b"`; got != want {
		t.Fatalf("QuoteIdentifier = %q, want %q", got, want)
	}
	if got, want := QuoteQualified("data", `odd"name`), `"data"."odd""name"`; got != want {
		t.Fatalf("QuoteQualified = %q, want %q", got, want)
	}
	if got, want := QuoteStringLiteral("it's.csv"), `'it''s.csv'`; got != want {
		t.Fatalf("QuoteStringLiteral = %q, want %q", got, want)
	}
	cases := map[string]string{
		"Sales 2026": "sales_2026",
		"123.csv":    "table_123_csv",
		"!!!":        "table",
		"":           "table",
	}
	for input, want := range cases {
		if got := NormalizeIdentifier(input); got != want {
			t.Errorf("NormalizeIdentifier(%q) = %q, want %q", input, got, want)
		}
	}

	db := testDatabase(t)
	ctx := context.Background()
	if _, err := db.SQL().ExecContext(ctx, `CREATE TABLE data.sales (id INTEGER)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.SQL().ExecContext(ctx, `CREATE TABLE data.sales_2 (id INTEGER)`); err != nil {
		t.Fatal(err)
	}
	name, err := UniqueTableName(ctx, db.SQL(), "data", "Sales")
	if err != nil {
		t.Fatal(err)
	}
	if name != "sales_3" {
		t.Fatalf("collision name = %q", name)
	}
}

func TestSerializePreciseAndNestedValues(t *testing.T) {
	decimal := duckdb.Decimal{Width: 30, Scale: 6, Value: func() *big.Int {
		value, _ := new(big.Int).SetString("12345678901234567890123456", 10)
		return value
	}()}
	if got, ok := SerializeValue(decimal).(string); !ok || got != decimal.String() {
		t.Fatalf("decimal was not preserved: %#v", got)
	}
	nested := SerializeValue([]any{int64(1 << 54), map[string]any{"blob": []byte{1, 2, 3}}})
	values := nested.([]any)
	if values[0] != "18014398509481984" {
		t.Fatalf("large integer was not stringified: %#v", values[0])
	}
	if values[1].(map[string]any)["blob"] != "<blob: 3 bytes>" {
		t.Fatalf("blob was not summarized: %#v", values[1])
	}
}
