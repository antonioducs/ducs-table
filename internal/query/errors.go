package query

import (
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"ducs-table/internal/models"

	duckdb "github.com/duckdb/duckdb-go/v2"
)

const maxQueryDiagnosticRunes = 2000

var (
	duckDBLocationPattern = regexp.MustCompile(`(?i)^LINE\s+(\d+):(?:\s?(.*))?$`)
	duckDBCaretPattern    = regexp.MustCompile(`^\s*\^+\s*$`)
	generatedResultName   = regexp.MustCompile(`(?i)(?:"?result"?\.)?"?__tmp_[a-f0-9]+"?`)
)

// ExecutionError exposes DuckDB's useful SQL diagnostic without serializing
// the SQL excerpt included in the raw driver error. Runtime, network, and I/O
// errors keep the caller-provided fallback. The original cause remains
// available to logs and errors.Is/errors.As through AppError.Unwrap.
func ExecutionError(cause error, fallback string) *models.AppError {
	fallback = strings.TrimSpace(fallback)
	if fallback == "" {
		fallback = "Query could not be executed"
	}
	if !safeDuckDBDiagnostic(cause) {
		return models.WrapError(models.CodeInvalidQuery, fallback, cause, nil)
	}
	message, line, column := queryDiagnostic(cause)
	details := map[string]any{}
	if line > 0 {
		details["line"] = line
		location := fmt.Sprintf("Line %d", line)
		if column > 0 {
			details["column"] = column
			location += fmt.Sprintf(", column %d", column)
		}
		details["suggestion"] = location
	}
	if len(details) == 0 {
		details = nil
	}
	return models.WrapError(models.CodeInvalidQuery, message, cause, details)
}

func queryExecutionError(cause error) *models.AppError {
	return ExecutionError(cause, "Query could not be executed")
}

func safeDuckDBDiagnostic(cause error) bool {
	var duckErr *duckdb.Error
	if !errors.As(cause, &duckErr) {
		return false
	}
	switch duckErr.Type {
	case duckdb.ErrorTypeMismatchType,
		duckdb.ErrorTypeInvalidType,
		duckdb.ErrorTypeNotImplemented,
		duckdb.ErrorTypeExpression,
		duckdb.ErrorTypeCatalog,
		duckdb.ErrorTypeParser,
		duckdb.ErrorTypePlanner,
		duckdb.ErrorTypeSyntax,
		duckdb.ErrorTypeBinder,
		duckdb.ErrorTypeParameterNotResolved,
		duckdb.ErrorTypeParameterNotAllowed:
		return true
	default:
		return false
	}
}

func queryDiagnostic(cause error) (message string, line, column int) {
	if cause == nil {
		return "Query could not be executed", 0, 0
	}
	raw := strings.TrimSpace(cause.Error())
	if raw == "" {
		return "Query could not be executed", 0, 0
	}

	lines := strings.Split(strings.ReplaceAll(raw, "\r\n", "\n"), "\n")
	kept := make([]string, 0, len(lines))
	for index := 0; index < len(lines); index++ {
		location := duckDBLocationPattern.FindStringSubmatch(lines[index])
		if location == nil {
			kept = append(kept, strings.TrimRight(lines[index], " \t"))
			continue
		}

		duckLine, parseErr := strconv.Atoi(location[1])
		if parseErr == nil && duckLine > 1 {
			// The validated user query starts on line two of the controlled
			// CREATE TABLE wrapper used by Run.
			line = duckLine - 1
		}
		if index+1 < len(lines) && duckDBCaretPattern.MatchString(lines[index+1]) {
			caret := strings.Index(lines[index+1], "^")
			prefixWidth := len("LINE ") + len(location[1]) + len(": ")
			if caret >= prefixWidth {
				column = caret - prefixWidth + 1
			}
			index++
		}
	}

	message = strings.TrimSpace(strings.Join(kept, "\n"))
	message = generatedResultName.ReplaceAllString(message, "query result")
	if message == "" {
		message = "Query could not be executed"
	}
	if utf8.RuneCountInString(message) > maxQueryDiagnosticRunes {
		runes := []rune(message)
		message = strings.TrimSpace(string(runes[:maxQueryDiagnosticRunes])) + "…"
	}
	return message, line, column
}
