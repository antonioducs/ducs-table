package query

import "testing"

func TestValidateReadOnly(t *testing.T) {
	accepted := []string{
		`SELECT 1`,
		`WITH x AS (SELECT 1 AS n) SELECT * FROM x;`,
		`SELECT ';not a statement' AS value -- ; DROP TABLE x`,
		"/* lead */ SELECT \"semi;column\" FROM (SELECT 1 AS \"semi;column\"); /* tail ; */",
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
		`SELECT write_blob('/tmp/not-allowed', 'x'::BLOB)`,
		`SELECT 'unterminated`,
	}
	for _, query := range rejected {
		if _, err := ValidateReadOnly(query); err == nil {
			t.Errorf("ValidateReadOnly(%q) unexpectedly succeeded", query)
		}
	}
}
