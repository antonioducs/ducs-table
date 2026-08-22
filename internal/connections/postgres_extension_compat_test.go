package connections

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"ducs-table/internal/credentials"
	"ducs-table/internal/database"
	"ducs-table/internal/extensions"
)

// Opt-in because it may download the official DuckDB PostgreSQL extension.
func TestPostgresExtensionSecretCompatibility(t *testing.T) {
	if os.Getenv("DUCS_TEST_EXTENSIONS") != "1" {
		t.Skip("set DUCS_TEST_EXTENSIONS=1 to check downloaded extension compatibility")
	}
	ctx := context.Background()
	db, err := database.OpenPath(ctx, filepath.Join(t.TempDir(), "workspace.duckdb"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	conn, err := db.SQL().Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	manager := extensions.NewManager()
	if err := manager.Ensure(ctx, conn, "postgres"); err != nil {
		t.Fatal(err)
	}
	var version string
	if err := conn.QueryRowContext(ctx, `SELECT version()`).Scan(&version); err != nil {
		t.Fatal(err)
	}
	t.Logf("DuckDB version: %s", version)
	rows, err := conn.QueryContext(ctx, `SELECT array_to_string(parameters, ','), array_to_string(parameter_types, ',') FROM duckdb_functions() WHERE function_name = 'postgres_configure_pool'`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var parameters, types string
		if err := rows.Scan(&parameters, &types); err != nil {
			t.Fatal(err)
		}
		t.Logf("postgres_configure_pool parameters: %s (%s)", parameters, types)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	settingRows, err := conn.QueryContext(ctx, `SELECT name FROM duckdb_settings() WHERE name LIKE 'pg_pool%' ORDER BY name`)
	if err != nil {
		t.Fatal(err)
	}
	defer settingRows.Close()
	for settingRows.Next() {
		var name string
		if err := settingRows.Scan(&name); err != nil {
			t.Fatal(err)
		}
		t.Logf("PostgreSQL pool setting: %s", name)
	}
	if err := settingRows.Err(); err != nil {
		t.Fatal(err)
	}
	info := validPostgresInfo()
	info.ID = "compat"
	info.CatalogName = "compat"
	plan := buildPostgresPlan(info, credentials.Secret{Password: "test-password"}, "compat")
	if _, err := conn.ExecContext(ctx, plan.createSecret); err != nil {
		t.Fatalf("CREATE SECRET failed: %v\nSQL shape: %s", err, Redact(plan.createSecret))
	}
	// Must remain non-fatal on extension builds that do not expose pool tuning.
	_ = configurePostgresPool(ctx, conn, plan.configurePool)
	if _, err := conn.ExecContext(ctx, `DROP SECRET `+database.QuoteIdentifier(plan.secretName)); err != nil {
		t.Fatal(err)
	}
}
