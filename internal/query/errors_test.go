package query

import (
	"errors"
	"strings"
	"testing"

	"ducs-table/internal/models"

	duckdb "github.com/duckdb/duckdb-go/v2"
)

func TestQueryExecutionErrorKeepsDiagnosticWithoutSQLExcerpt(t *testing.T) {
	cause := &duckdb.Error{Type: duckdb.ErrorTypeBinder, Msg: "Binder Error: Referenced column \"missing_total\" not found in FROM clause!\nCandidate bindings: \"total\"\n\nLINE 3: SELECT missing_total FROM orders\n                      ^"}
	err := queryExecutionError(cause)

	if err.Code != models.CodeInvalidQuery {
		t.Fatalf("code = %q", err.Code)
	}
	if !strings.Contains(err.Message, "missing_total") || !strings.Contains(err.Message, "Candidate bindings") {
		t.Fatalf("diagnostic was lost: %q", err.Message)
	}
	if strings.Contains(err.Message, "SELECT missing_total") {
		t.Fatalf("SQL excerpt was exposed: %q", err.Message)
	}
	if err.Details["line"] != 2 || err.Details["column"] != 15 || err.Details["suggestion"] != "Line 2, column 15" {
		t.Fatalf("location = %#v", err.Details)
	}
	if !errors.Is(err, cause) {
		t.Fatal("original cause was not retained")
	}
}

func TestQueryExecutionErrorDoesNotExposeRuntimeCause(t *testing.T) {
	cause := &duckdb.Error{Type: duckdb.ErrorTypeIO, Msg: "IO Error: secret path and connection details"}
	err := queryExecutionError(cause)
	if err.Message != "Query could not be executed" || err.Details != nil {
		t.Fatalf("runtime diagnostic was exposed: %#v", err)
	}
	if !errors.Is(err, cause) {
		t.Fatal("original runtime cause was not retained")
	}
}

func TestQueryDiagnosticFallsBackSafely(t *testing.T) {
	message, line, column := queryDiagnostic(nil)
	if message != "Query could not be executed" || line != 0 || column != 0 {
		t.Fatalf("fallback = %q, %d, %d", message, line, column)
	}
}
