package ai

import "testing"

func TestValidateProjectSQLBlocksEscapeHatchesAndCrossProjectReferences(t *testing.T) {
	scope := SQLScope{
		Catalogs:     map[string]bool{"project_db": true},
		LocalTables:  map[string]bool{"orders": true},
		ResultTables: map[string]bool{"preview_1": true},
	}
	accepted := []string{
		`SELECT * FROM data.orders`,
		`SELECT * FROM orders`,
		`SELECT * FROM preview_1`,
		`SELECT * FROM "project_db"."public"."customers"`,
		`WITH x AS (SELECT * FROM result.preview_1) SELECT * FROM x`,
		`WITH first AS (SELECT * FROM orders), second AS (SELECT * FROM first) SELECT * FROM second`,
		`SELECT * FROM orders o JOIN preview_1 p ON p.id = o.id`,
		`SELECT * FROM orders, preview_1`,
		`SELECT * FROM (orders)`,
		`SELECT * FROM range(10)`,
	}
	for _, statement := range accepted {
		if _, err := ValidateProjectSQL(statement, scope); err != nil {
			t.Errorf("expected %q to pass: %v", statement, err)
		}
	}
	rejected := []string{
		`SELECT * FROM data.other_project_table`,
		`SELECT * FROM other_project_table`,
		`SELECT * FROM orders, other_project_table`,
		`SELECT * FROM (other_project_table)`,
		`WITH leaked AS (SELECT * FROM other_project_table) SELECT * FROM leaked`,
		`SELECT * FROM orders o JOIN other_project_table x ON x.id = o.id`,
		`SELECT * FROM other_db.public.customers`,
		`SELECT * FROM read_csv_auto('/tmp/secret.csv')`,
		`SELECT * FROM '/tmp/secret.csv'`,
		`SELECT * FROM 'https://example.test/data.csv'`,
		`SELECT * FROM read_json('https://example.test/data.json')`,
		`SELECT * FROM read_parquet('/tmp/data.parquet')`,
		`SELECT * FROM glob('/tmp/*')`,
		`SELECT getenv('OPENAI_API_KEY')`,
		`SELECT * FROM duckdb_secrets()`,
	}
	for _, statement := range rejected {
		if _, err := ValidateProjectSQL(statement, scope); err == nil {
			t.Errorf("expected %q to be rejected", statement)
		}
	}
}

func TestValidateProjectSQLBlocksInternalSchemasAndFileReaders(t *testing.T) {
	scope := SQLScope{Catalogs: map[string]bool{"prod": true}, LocalTables: map[string]bool{"orders": true}, ResultTables: map[string]bool{}}
	for _, statement := range []string{
		`SELECT * FROM ducs_meta.connections`,
		`SELECT * FROM information_schema.tables`,
		`SELECT * FROM read_csv_auto('/tmp/secret.csv')`,
		`SELECT * FROM duckdb_tables()`,
	} {
		if _, err := ValidateProjectSQL(statement, scope); err == nil {
			t.Fatalf("expected AI SQL to be rejected: %s", statement)
		}
	}
}

func TestRedactStringAndSanitize(t *testing.T) {
	input := "postgres://user:supersecret@db/test password=hunter2 Authorization: Bearer abc.def"
	redacted := RedactString(input)
	for _, secret := range []string{"supersecret", "hunter2", "abc.def"} {
		if contains(redacted, secret) {
			t.Fatalf("redaction leaked %q in %q", secret, redacted)
		}
	}
	clean := Sanitize(map[string]any{"name": "ok", "api_token": "secret", "nested": map[string]any{"password": "secret"}}).(map[string]any)
	if clean["name"] != "ok" || clean["api_token"] != nil {
		t.Fatalf("unexpected sanitized value: %#v", clean)
	}
}

func contains(value, fragment string) bool {
	for i := 0; i+len(fragment) <= len(value); i++ {
		if value[i:i+len(fragment)] == fragment {
			return true
		}
	}
	return false
}
