package database

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"

	"ducs-table/internal/models"
)

// Queryer is implemented by *sql.DB, *sql.Conn, and *sql.Tx.
type Queryer interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

// QuoteIdentifier quotes one catalog identifier using SQL standard escaping.
func QuoteIdentifier(identifier string) string {
	return `"` + strings.ReplaceAll(identifier, `"`, `""`) + `"`
}

// QuoteQualified quotes every component of a qualified catalog name.
func QuoteQualified(parts ...string) string {
	quoted := make([]string, len(parts))
	for i, part := range parts {
		quoted[i] = QuoteIdentifier(part)
	}
	return strings.Join(quoted, ".")
}

// QuoteStringLiteral safely embeds a value where DuckDB does not support a
// parameter (notably COPY destinations and SET paths).
func QuoteStringLiteral(value string) string {
	return `'` + strings.ReplaceAll(value, `'`, `''`) + `'`
}

// QuotePathLiteral is a deliberately named path-only wrapper used by export.
func QuotePathLiteral(path string) string { return QuoteStringLiteral(path) }

// NormalizeIdentifier creates a predictable unquoted-style catalog name while
// retaining Unicode letters and digits. Invalid runs become a single underscore.
func NormalizeIdentifier(input string) string {
	input = strings.TrimSpace(strings.ToLower(input))
	var b strings.Builder
	lastUnderscore := false
	for _, r := range input {
		valid := unicode.IsLetter(r) || unicode.IsDigit(r) || r == '_'
		if !valid {
			r = '_'
		}
		if r == '_' {
			if lastUnderscore {
				continue
			}
			lastUnderscore = true
		} else {
			lastUnderscore = false
		}
		b.WriteRune(r)
	}
	name := strings.Trim(b.String(), "_")
	if name == "" {
		name = "table"
	}
	first, _ := utf8.DecodeRuneInString(name)
	if unicode.IsDigit(first) {
		name = "table_" + name
	}
	return name
}

// UniqueTableName resolves collisions against the DuckDB catalog by appending
// _2, _3, ... to the normalized base name.
func UniqueTableName(ctx context.Context, q Queryer, schema, desired string) (string, error) {
	base := NormalizeIdentifier(desired)
	for suffix := 1; ; suffix++ {
		candidate := base
		if suffix > 1 {
			candidate = fmt.Sprintf("%s_%d", base, suffix)
		}
		exists, err := TableExists(ctx, q, schema, candidate)
		if err != nil {
			return "", err
		}
		if !exists {
			return candidate, nil
		}
	}
}

func TableExists(ctx context.Context, q Queryer, schema, table string) (bool, error) {
	var exists bool
	err := q.QueryRowContext(ctx, `SELECT EXISTS (
		SELECT 1 FROM information_schema.tables
		WHERE table_schema = ? AND table_name = ?
	)`, schema, table).Scan(&exists)
	return exists, err
}

// Columns introspects a table without interpolating catalog values.
func Columns(ctx context.Context, q Queryer, schema, table string) ([]models.ColumnInfo, error) {
	rows, err := q.QueryContext(ctx, `
		SELECT column_name, data_type, is_nullable, ordinal_position
		FROM information_schema.columns
		WHERE table_schema = ? AND table_name = ?
		ORDER BY ordinal_position`, schema, table)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	columns := make([]models.ColumnInfo, 0)
	for rows.Next() {
		var column models.ColumnInfo
		var nullable string
		if err := rows.Scan(&column.Name, &column.Type, &nullable, &column.Ordinal); err != nil {
			return nil, err
		}
		column.Nullable = strings.EqualFold(nullable, "YES")
		columns = append(columns, column)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(columns) == 0 {
		exists, existsErr := TableExists(ctx, q, schema, table)
		if existsErr != nil {
			return nil, existsErr
		}
		if !exists {
			return nil, models.NewError(models.CodeSourceNotFound, "Source table was not found", map[string]any{"schema": schema, "table": table})
		}
	}
	return columns, nil
}
