package ai

import (
	"fmt"
	"regexp"
	"strings"
)

var (
	credentialAssignment = regexp.MustCompile(`(?i)(password|passwd|pwd|token|api[_-]?key|secret|authorization)\s*([:=])\s*([^\s,;]+)`)
	credentialURL        = regexp.MustCompile(`(?i)([a-z][a-z0-9+.-]*://[^\s/@:]+:)([^\s/@]+)(@)`)
	bearerToken          = regexp.MustCompile(`(?i)\b(bearer\s+)[a-z0-9._~+/-]+=*`)
	authorizationHeader  = regexp.MustCompile(`(?i)\b(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+`)
)

func RedactString(value string) string {
	value = credentialURL.ReplaceAllString(value, `${1}[REDACTED]${3}`)
	value = authorizationHeader.ReplaceAllString(value, `${1}[REDACTED]`)
	value = credentialAssignment.ReplaceAllString(value, `${1}${2}[REDACTED]`)
	return bearerToken.ReplaceAllString(value, `${1}[REDACTED]`)
}

// Sanitize removes secret-shaped fields recursively before untrusted values
// are persisted, emitted to Wails, or returned to a provider process.
func Sanitize(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		result := make(map[string]any, len(typed))
		for key, item := range typed {
			if sensitiveKey(key) {
				continue
			}
			result[key] = Sanitize(item)
		}
		return result
	case []any:
		result := make([]any, len(typed))
		for i, item := range typed {
			result[i] = Sanitize(item)
		}
		return result
	case string:
		return RedactString(typed)
	default:
		return typed
	}
}

func sensitiveKey(key string) bool {
	key = strings.ToLower(strings.ReplaceAll(strings.ReplaceAll(key, "-", ""), "_", ""))
	for _, fragment := range []string{"password", "passwd", "secret", "token", "apikey", "authorization", "credential"} {
		if strings.Contains(key, fragment) {
			return true
		}
	}
	return false
}

func safeError(err error) string {
	if err == nil {
		return ""
	}
	return RedactString(fmt.Sprint(err))
}
