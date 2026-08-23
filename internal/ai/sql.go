package ai

import (
	"strings"
	"unicode"
	"unicode/utf8"

	"ducs-table/internal/models"
	"ducs-table/internal/query"
)

type SQLScope struct {
	Catalogs     map[string]bool
	LocalTables  map[string]bool
	ResultTables map[string]bool
}

var blockedAIIdentifiers = map[string]struct{}{
	"glob": {}, "getenv": {}, "current_setting": {}, "read_blob": {}, "read_text": {}, "read_xlsx": {},
	"read_csv": {}, "read_csv_auto": {}, "read_json": {}, "read_json_auto": {}, "read_json_objects": {},
	"read_ndjson": {}, "read_ndjson_auto": {}, "read_ndjson_objects": {}, "read_parquet": {}, "parquet_scan": {},
	"sqlite_scan": {}, "delta_scan": {}, "iceberg_scan": {}, "st_read": {}, "duckdb_settings": {},
	"duckdb_tables": {}, "duckdb_columns": {}, "duckdb_constraints": {}, "duckdb_functions": {},
}

var blockedAISchemas = map[string]struct{}{
	"ducs_meta": {}, "information_schema": {}, "pg_catalog": {}, "main": {}, "temp": {},
}

// ValidateProjectSQL applies the common read-only policy and then ensures all
// explicit catalog and local schema references belong to the active project.
func ValidateProjectSQL(input string, scope SQLScope) (string, error) {
	validated, err := query.ValidateReadOnly(input)
	if err != nil {
		return "", err
	}
	parts, err := sqlIdentifiers(validated)
	if err != nil {
		return "", models.NewError(models.CodeInvalidQuery, "SQL query contains invalid syntax", nil)
	}
	for _, part := range parts {
		if part.kind != identPart {
			continue
		}
		identifier := strings.ToLower(part.value)
		if _, blocked := blockedAIIdentifiers[identifier]; blocked || strings.HasPrefix(identifier, "read_") || strings.HasPrefix(identifier, "http_") || strings.HasPrefix(identifier, "duckdb_") || strings.HasPrefix(identifier, "pragma_") || strings.HasSuffix(identifier, "_scan") {
			return "", models.NewError(models.CodeReadOnlyQueryRequired, "AI query uses a blocked external or metadata function", map[string]any{"identifier": part.value})
		}
	}
	for i := 0; i+4 < len(parts); i++ {
		if parts[i].kind != identPart || parts[i+1].kind != dotPart || parts[i+2].kind != identPart || parts[i+3].kind != dotPart || parts[i+4].kind != identPart {
			continue
		}
		catalog := strings.ToLower(parts[i].value)
		if !containsFold(scope.Catalogs, catalog) {
			return "", models.NewError(models.CodeReadOnlyQueryRequired, "AI query references a catalog outside the active project", map[string]any{"catalog": parts[i].value})
		}
	}
	for i := 0; i+2 < len(parts); i++ {
		if parts[i].kind != identPart || parts[i+1].kind != dotPart || parts[i+2].kind != identPart {
			continue
		}
		schema := strings.ToLower(parts[i].value)
		table := parts[i+2].value
		if _, blocked := blockedAISchemas[schema]; blocked {
			return "", models.NewError(models.CodeReadOnlyQueryRequired, "AI query references an internal schema", map[string]any{"schema": parts[i].value})
		}
		if schema == "data" && !containsFold(scope.LocalTables, table) {
			return "", models.NewError(models.CodeReadOnlyQueryRequired, "AI query references a table outside the active project", map[string]any{"schema": schema, "table": table})
		}
		if schema == "result" && !containsFold(scope.ResultTables, table) {
			return "", models.NewError(models.CodeReadOnlyQueryRequired, "AI query references a result outside the active project", map[string]any{"schema": schema, "table": table})
		}
	}
	if err := validateUnqualifiedRelations(parts, scope); err != nil {
		return "", err
	}
	return validated, nil
}

func validateUnqualifiedRelations(parts []sqlPart, scope SQLScope) error {
	ctes := collectCTENames(parts)
	activeFrom := make(map[int]bool)
	expectRelation := make(map[int]bool)
	depth := 0
	for i, part := range parts {
		switch part.kind {
		case openParenPart:
			wasExpectingRelation := expectRelation[depth]
			expectRelation[depth] = false
			depth++
			if wasExpectingRelation && !startsSQLSubquery(parts, i+1) {
				activeFrom[depth] = true
				expectRelation[depth] = true
			}
		case closeParenPart:
			delete(activeFrom, depth)
			delete(expectRelation, depth)
			if depth > 0 {
				depth--
			}
		case commaPart:
			if activeFrom[depth] {
				expectRelation[depth] = true
			}
		case stringPart:
			if expectRelation[depth] {
				return models.NewError(models.CodeReadOnlyQueryRequired, "AI query uses a blocked external relation", nil)
			}
		case identPart:
			identifier := strings.ToLower(part.value)
			switch identifier {
			case "from":
				activeFrom[depth] = true
				expectRelation[depth] = true
				continue
			case "join":
				activeFrom[depth] = true
				expectRelation[depth] = true
				continue
			case "where", "group", "order", "having", "qualify", "window", "limit", "offset", "fetch", "union", "except", "intersect", "on", "using":
				activeFrom[depth] = false
				expectRelation[depth] = false
				continue
			}
			if !expectRelation[depth] {
				continue
			}
			if identifier == "lateral" || identifier == "only" {
				continue
			}
			expectRelation[depth] = false
			// Qualified relations are checked by the catalog/schema passes above.
			if i+1 < len(parts) && parts[i+1].kind == dotPart {
				continue
			}
			// Safe table-producing functions (for example range or unnest) are not
			// project relations. External/metadata functions are blocked above.
			if i+1 < len(parts) && parts[i+1].kind == openParenPart {
				continue
			}
			if ctes[identifier] || containsFold(scope.LocalTables, part.value) || containsFold(scope.ResultTables, part.value) {
				continue
			}
			return models.NewError(models.CodeReadOnlyQueryRequired, "AI query references a table outside the active project", map[string]any{"table": part.value})
		}
	}
	return nil
}

func startsSQLSubquery(parts []sqlPart, index int) bool {
	if index >= len(parts) {
		return false
	}
	if parts[index].kind == openParenPart {
		return false // Carry relation expectation through nested parentheses.
	}
	return isSQLIdentifier(parts[index], "select") || isSQLIdentifier(parts[index], "with") || isSQLIdentifier(parts[index], "values")
}

func collectCTENames(parts []sqlPart) map[string]bool {
	ctes := make(map[string]bool)
	for start, part := range parts {
		if part.kind != identPart || !strings.EqualFold(part.value, "with") {
			continue
		}
		i := start + 1
		if i < len(parts) && isSQLIdentifier(parts[i], "recursive") {
			i++
		}
		for i < len(parts) && parts[i].kind == identPart {
			name := parts[i].value
			i++
			if i < len(parts) && parts[i].kind == openParenPart {
				i = afterSQLGroup(parts, i)
			}
			if i >= len(parts) || !isSQLIdentifier(parts[i], "as") {
				break
			}
			i++
			if i < len(parts) && isSQLIdentifier(parts[i], "not") {
				i++
				if i < len(parts) && isSQLIdentifier(parts[i], "materialized") {
					i++
				}
			} else if i < len(parts) && isSQLIdentifier(parts[i], "materialized") {
				i++
			}
			if i >= len(parts) || parts[i].kind != openParenPart {
				break
			}
			ctes[strings.ToLower(name)] = true
			i = afterSQLGroup(parts, i)
			if i >= len(parts) || parts[i].kind != commaPart {
				break
			}
			i++
		}
	}
	return ctes
}

func afterSQLGroup(parts []sqlPart, start int) int {
	depth := 0
	for i := start; i < len(parts); i++ {
		switch parts[i].kind {
		case openParenPart:
			depth++
		case closeParenPart:
			depth--
			if depth == 0 {
				return i + 1
			}
		}
	}
	return len(parts)
}

func isSQLIdentifier(part sqlPart, value string) bool {
	return part.kind == identPart && strings.EqualFold(part.value, value)
}

func containsFold(values map[string]bool, value string) bool {
	if values[value] || values[strings.ToLower(value)] {
		return true
	}
	for candidate, allowed := range values {
		if allowed && strings.EqualFold(candidate, value) {
			return true
		}
	}
	return false
}

type partKind uint8

const (
	identPart partKind = iota + 1
	dotPart
	openParenPart
	closeParenPart
	commaPart
	stringPart
)

type sqlPart struct {
	kind  partKind
	value string
}

func sqlIdentifiers(input string) ([]sqlPart, error) {
	parts := make([]sqlPart, 0)
	for i := 0; i < len(input); {
		r, size := utf8.DecodeRuneInString(input[i:])
		if r == utf8.RuneError && size == 1 {
			return nil, models.NewError(models.CodeInvalidQuery, "SQL query contains invalid UTF-8", nil)
		}
		if unicode.IsSpace(r) {
			i += size
			continue
		}
		if i+1 < len(input) && input[i:i+2] == "--" {
			i += 2
			for i < len(input) && input[i] != '\n' && input[i] != '\r' {
				_, n := utf8.DecodeRuneInString(input[i:])
				i += n
			}
			continue
		}
		if i+1 < len(input) && input[i:i+2] == "/*" {
			depth := 1
			i += 2
			for i < len(input) && depth > 0 {
				if i+1 < len(input) && input[i:i+2] == "/*" {
					depth++
					i += 2
				} else if i+1 < len(input) && input[i:i+2] == "*/" {
					depth--
					i += 2
				} else {
					_, n := utf8.DecodeRuneInString(input[i:])
					i += n
				}
			}
			if depth != 0 {
				return nil, models.NewError(models.CodeInvalidQuery, "SQL block comment is not terminated", nil)
			}
			continue
		}
		if input[i] == '\'' {
			end, ok := consumeSQLQuote(input, i, '\'')
			if !ok {
				return nil, models.NewError(models.CodeInvalidQuery, "SQL string is not terminated", nil)
			}
			parts = append(parts, sqlPart{kind: stringPart})
			i = end
			continue
		}
		if input[i] == '"' {
			end, ok := consumeSQLQuote(input, i, '"')
			if !ok {
				return nil, models.NewError(models.CodeInvalidQuery, "Quoted identifier is not terminated", nil)
			}
			parts = append(parts, sqlPart{kind: identPart, value: strings.ReplaceAll(input[i+1:end-1], `""`, `"`)})
			i = end
			continue
		}
		if input[i] == '.' {
			parts = append(parts, sqlPart{kind: dotPart, value: "."})
			i++
			continue
		}
		if input[i] == '(' {
			parts = append(parts, sqlPart{kind: openParenPart, value: "("})
			i++
			continue
		}
		if input[i] == ')' {
			parts = append(parts, sqlPart{kind: closeParenPart, value: ")"})
			i++
			continue
		}
		if input[i] == ',' {
			parts = append(parts, sqlPart{kind: commaPart, value: ","})
			i++
			continue
		}
		if r == '_' || unicode.IsLetter(r) {
			start := i
			i += size
			for i < len(input) {
				next, nextSize := utf8.DecodeRuneInString(input[i:])
				if next != '_' && next != '$' && !unicode.IsLetter(next) && !unicode.IsDigit(next) {
					break
				}
				i += nextSize
			}
			parts = append(parts, sqlPart{kind: identPart, value: input[start:i]})
			continue
		}
		i += size
	}
	return parts, nil
}

func consumeSQLQuote(input string, start int, quote byte) (int, bool) {
	for i := start + 1; i < len(input); i++ {
		if input[i] != quote {
			continue
		}
		if i+1 < len(input) && input[i+1] == quote {
			i++
			continue
		}
		return i + 1, true
	}
	return len(input), false
}
