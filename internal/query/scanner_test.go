package query

import "testing"

func TestValidateReadOnly(t *testing.T) {
	accepted := []string{
		`SELECT 1`,
		`WITH x AS (SELECT 1 AS n) SELECT * FROM x;`,
		`SELECT ';not a statement' AS value -- ; DROP TABLE x`,
		"/* lead */ SELECT \"semi;column\" FROM (SELECT 1 AS \"semi;column\"); /* tail ; */",
		`SELECT "postgres_execute" FROM (SELECT 1 AS "postgres_execute")`,
		`SELECT * FROM "prod"."public"."postgres_query"`,
	}
	for _, query := range accepted {
		if _, err := ValidateReadOnly(query); err != nil {
			t.Errorf("ValidateReadOnly(%q): %v", query, err)
		}
	}
	rejected := []string{
		`CREATE TABLE x AS SELECT 1`,
		`SELECT 1; SELECT 2`,
		`WITH deleted AS (DELETE FROM x RETURNING *) SELECT * FROM deleted`,
		`WITH x AS (SELECT 1) INSERT INTO y SELECT * FROM x`,
		`SELECT 1; ;`,
		`SELECT 1; 'not trailing'`,
		`SELECT write_blob('/tmp/not-allowed', 'x'::BLOB)`,
		`SELECT * FROM PoStGrEs_QuErY('prod', 'DELETE FROM users')`,
		`WITH x AS (SELECT 1) SELECT * FROM /* hidden */ mongo_scan('mongodb://user:pass@host/db', 'db', 'c')`,
		`SELECT * FROM postgres_scan('password=secret', 'public', 'users')`,
		`SELECT * FROM query_table('duckdb_secrets()')`,
		`SELECT path FROM duckdb_databases()`,
		`SELECT * FROM mongo_clear_cache()`,
		`SELECT * FROM "postgres_query" /* hidden */ ('prod', 'DELETE FROM users')`,
		`SELECT 'unterminated`,
	}
	for _, query := range rejected {
		if _, err := ValidateReadOnly(query); err == nil {
			t.Errorf("ValidateReadOnly(%q) unexpectedly succeeded", query)
		}
	}
}
