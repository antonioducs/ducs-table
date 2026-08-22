package connections

import (
	"net/url"
	"regexp"
	"strings"
)

var sensitiveKV = regexp.MustCompile(`(?i)(password|passwd|pwd|token|secret)\s*(=|:)\s*([^\s&;]+)`)
var uriUserInfo = regexp.MustCompile(`(?i)([a-z][a-z0-9+.-]*://)([^/@\s]+)@`)

// Redact removes the common credential forms used by libpq and MongoDB. It is
// intended for defensive tests and diagnostics; provider failures still avoid
// returning raw driver causes entirely.
func Redact(value string) string {
	value = uriUserInfo.ReplaceAllString(value, `${1}[redacted]@`)
	value = sensitiveKV.ReplaceAllString(value, `${1}${2}[redacted]`)
	if parsed, err := url.Parse(value); err == nil && parsed.RawQuery != "" {
		query := parsed.Query()
		for key := range query {
			lower := strings.ToLower(key)
			if strings.Contains(lower, "password") || strings.Contains(lower, "token") || strings.Contains(lower, "secret") {
				query.Set(key, "[redacted]")
			}
		}
		parsed.RawQuery = query.Encode()
		value = parsed.String()
	}
	return value
}

func providerFailureMessage(kind ConnectionKind, err error) string {
	provider := "external database"
	if kind == KindPostgres {
		provider = "PostgreSQL"
	}
	if kind == KindMongo {
		provider = "MongoDB"
	}
	if err == nil {
		return "Could not connect to " + provider + ". Check the connection settings"
	}
	message := strings.ToLower(err.Error())
	switch {
	case strings.Contains(message, "password authentication failed"), strings.Contains(message, "authentication failed"), strings.Contains(message, "auth failed"), strings.Contains(message, "unauthorized"), strings.Contains(message, "bad auth"):
		return provider + " rejected the username or password"
	case strings.Contains(message, "database") && (strings.Contains(message, "does not exist") || strings.Contains(message, "not found")):
		return "The configured " + provider + " database does not exist"
	case strings.Contains(message, "connection refused"), strings.Contains(message, "actively refused"):
		return provider + " refused the connection. Check the host, port, firewall, and whether the server is running"
	case strings.Contains(message, "no such host"), strings.Contains(message, "name or service not known"), strings.Contains(message, "nodename nor servname"), strings.Contains(message, "dns"):
		return "The " + provider + " host name could not be resolved"
	case strings.Contains(message, "timeout"), strings.Contains(message, "timed out"), strings.Contains(message, "server selection"):
		return "The " + provider + " connection timed out. Check network access and the connect timeout"
	case strings.Contains(message, "certificate"), strings.Contains(message, "tls"), strings.Contains(message, "ssl"):
		return provider + " TLS/SSL negotiation failed. Check the TLS mode and server certificate"
	case strings.Contains(message, "pg_hba.conf"):
		return "PostgreSQL rejected this client in pg_hba.conf"
	case strings.Contains(message, "network is unreachable"), strings.Contains(message, "no route to host"):
		return "The " + provider + " network is unreachable"
	default:
		return "Could not connect to " + provider + ". Check the host, credentials, database, and TLS settings"
	}
}
