package query

import (
	"strings"
	"unicode"
	"unicode/utf8"

	"ducs-table/internal/models"
)

var forbiddenTokens = map[string]struct{}{
	"ALTER": {}, "ATTACH": {}, "CALL": {}, "CHECKPOINT": {}, "COPY": {}, "CREATE": {},
	"DELETE": {}, "DETACH": {}, "DROP": {}, "EXECUTE": {}, "EXPORT": {},
	"FORCE": {}, "IMPORT": {}, "INSERT": {}, "INSTALL": {}, "LOAD": {},
	"FORCE_CHECKPOINT": {}, "HTTP_DELETE": {}, "HTTP_GET": {}, "HTTP_HEAD": {}, "HTTP_PATCH": {}, "HTTP_POST": {}, "HTTP_PUT": {},
	"MERGE": {}, "NEXTVAL": {}, "PREPARE": {}, "PRAGMA": {}, "REPLACE": {},
	"RESET": {}, "SET": {}, "SETSEED": {}, "TRUNCATE": {}, "UPDATE": {},
	"USE": {}, "VACUUM": {}, "WRITE_BLOB": {}, "WRITE_TEXT": {}, "INTO": {},
	"POSTGRES_EXECUTE": {}, "POSTGRES_QUERY": {}, "POSTGRES_SCAN": {},
	"POSTGRES_SCAN_PUSHDOWN": {}, "POSTGRES_ATTACH": {}, "POSTGRES_CONFIGURE_POOL": {},
	"PG_CLEAR_CACHE": {}, "MONGO_SCAN": {}, "MONGO_CLEAR_CACHE": {},
	"DUCKDB_SECRETS": {}, "DUCKDB_SECRET_TYPES": {}, "WHICH_SECRET": {}, "DUCKDB_DATABASES": {}, "PRAGMA_DATABASE_LIST": {}, "DUCKDB_LOGS": {}, "DUCKDB_LOG_CONTEXTS": {}, "DUCKDB_PREPARED_STATEMENTS": {}, "DUCKDB_EXTENSIONS": {}, "DUCKDB_EXTENSION_REPOSITORIES": {},
	"QUERY": {}, "QUERY_TABLE": {}, "READ_POSTGRES_BINARY": {},
}

type scanResult struct {
	tokens      []string
	semicolonAt int
}

// ValidateReadOnly accepts exactly one SELECT/WITH statement. It understands
// SQL strings, quoted identifiers, line comments, nested block comments, and a
// single optional trailing semicolon. Returned SQL has that semicolon removed
// so it can be placed safely inside a controlled subquery.
func ValidateReadOnly(input string) (string, error) {
	input = strings.TrimSpace(strings.TrimPrefix(input, "\ufeff"))
	if input == "" {
		return "", models.NewError(models.CodeInvalidQuery, "SQL query is empty", nil)
	}
	result, semicolonByte, err := scanSQL(input)
	if err != nil {
		return "", err
	}
	if len(result.tokens) == 0 {
		return "", models.NewError(models.CodeInvalidQuery, "SQL query contains no statement", nil)
	}
	first := result.tokens[0]
	if first != "SELECT" && first != "WITH" {
		return "", models.NewError(models.CodeReadOnlyQueryRequired, "Only SELECT or WITH queries are allowed", map[string]any{"firstToken": first})
	}
	for _, token := range result.tokens {
		if _, forbidden := forbiddenTokens[token]; forbidden {
			return "", models.NewError(models.CodeReadOnlyQueryRequired, "Query contains a statement that can modify state", map[string]any{"token": token})
		}
	}
	if semicolonByte >= 0 {
		input = input[:semicolonByte] + input[semicolonByte+1:]
	}
	return strings.TrimSpace(input), nil
}

func scanSQL(input string) (scanResult, int, error) {
	result := scanResult{semicolonAt: -1}
	semicolonByte := -1
	for i := 0; i < len(input); {
		r, size := utf8.DecodeRuneInString(input[i:])
		if r == utf8.RuneError && size == 1 {
			return result, -1, invalidSyntax("SQL query contains invalid UTF-8")
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
			end, ok := consumeBlockComment(input, i)
			if !ok {
				return result, -1, invalidSyntax("SQL block comment is not terminated")
			}
			i = end
			continue
		}
		if input[i] == '\'' {
			if semicolonByte >= 0 {
				return result, -1, invalidSyntax("Only a trailing semicolon is allowed")
			}
			end, ok := consumeQuoted(input, i, '\'')
			if !ok {
				return result, -1, invalidSyntax("SQL string is not terminated")
			}
			i = end
			continue
		}
		if input[i] == '"' {
			if semicolonByte >= 0 {
				return result, -1, invalidSyntax("Only a trailing semicolon is allowed")
			}
			end, ok := consumeQuoted(input, i, '"')
			if !ok {
				return result, -1, invalidSyntax("Quoted identifier is not terminated")
			}
			identifier := strings.ReplaceAll(input[i+1:end-1], `""`, `"`)
			if next, ok := nextSignificant(input, end); ok && input[next] == '(' {
				result.tokens = append(result.tokens, strings.ToUpper(identifier))
			}
			i = end
			continue
		}
		if input[i] == ';' {
			if semicolonByte >= 0 {
				return result, -1, invalidSyntax("Only one SQL statement is allowed")
			}
			semicolonByte = i
			result.semicolonAt = len(result.tokens)
			i++
			continue
		}
		if isWordStart(r) {
			start := i
			i += size
			for i < len(input) {
				next, nextSize := utf8.DecodeRuneInString(input[i:])
				if !isWordPart(next) {
					break
				}
				i += nextSize
			}
			if semicolonByte >= 0 {
				return result, -1, invalidSyntax("Only a trailing semicolon is allowed")
			}
			result.tokens = append(result.tokens, strings.ToUpper(input[start:i]))
			continue
		}
		if semicolonByte >= 0 {
			return result, -1, invalidSyntax("Only a trailing semicolon is allowed")
		}
		i += size
	}
	return result, semicolonByte, nil
}

func nextSignificant(input string, start int) (int, bool) {
	for i := start; i < len(input); {
		r, size := utf8.DecodeRuneInString(input[i:])
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
			end, ok := consumeBlockComment(input, i)
			if !ok {
				return 0, false
			}
			i = end
			continue
		}
		return i, true
	}
	return 0, false
}

func consumeQuoted(input string, start int, quote byte) (int, bool) {
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

func consumeBlockComment(input string, start int) (int, bool) {
	depth := 1
	for i := start + 2; i < len(input); {
		if i+1 < len(input) && input[i:i+2] == "/*" {
			depth++
			i += 2
			continue
		}
		if i+1 < len(input) && input[i:i+2] == "*/" {
			depth--
			i += 2
			if depth == 0 {
				return i, true
			}
			continue
		}
		_, size := utf8.DecodeRuneInString(input[i:])
		i += size
	}
	return len(input), false
}

func isWordStart(r rune) bool { return r == '_' || unicode.IsLetter(r) }
func isWordPart(r rune) bool  { return isWordStart(r) || unicode.IsDigit(r) || r == '$' }

func invalidSyntax(message string) error {
	return models.NewError(models.CodeInvalidQuery, message, nil)
}
