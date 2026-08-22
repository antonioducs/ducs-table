package connections

import (
	"context"
	"database/sql"
	"net"
	"net/url"
	"strconv"
	"strings"

	"ducs-table/internal/credentials"
	"ducs-table/internal/database"
	"ducs-table/internal/extensions"
	"ducs-table/internal/models"
)

func buildMongoURI(config MongoConfig, secret credentials.Secret) (string, error) {
	authority := strings.Join(config.Hosts, ",")
	if config.Username != "" {
		if secret.Password != "" {
			authority = escapeURIComponent(config.Username) + ":" + escapeURIComponent(secret.Password) + "@" + authority
		} else {
			authority = escapeURIComponent(config.Username) + "@" + authority
		}
	}
	query := url.Values{}
	if config.AuthSource != "" {
		query.Set("authSource", config.AuthSource)
	}
	if config.TLS {
		query.Set("tls", "true")
	}
	if config.ReplicaSet != "" {
		query.Set("replicaSet", config.ReplicaSet)
	}
	if config.DirectConnection {
		query.Set("directConnection", "true")
	}
	if config.ReadPreference != "" {
		query.Set("readPreference", config.ReadPreference)
	}
	query.Set("connectTimeoutMS", strconv.Itoa(config.ConnectTimeoutSeconds*1000))
	return config.Mode + "://" + authority + "/" + escapeURIComponent(config.Database) + "?" + query.Encode(), nil
}

func escapeURIComponent(value string) string {
	const hex = "0123456789ABCDEF"
	var builder strings.Builder
	for _, b := range []byte(value) {
		if (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z') || (b >= '0' && b <= '9') || b == '-' || b == '.' || b == '_' || b == '~' {
			builder.WriteByte(b)
			continue
		}
		builder.WriteByte('%')
		builder.WriteByte(hex[b>>4])
		builder.WriteByte(hex[b&15])
	}
	return builder.String()
}

func attachMongo(ctx context.Context, conn *sql.Conn, manager *extensions.Manager, info ConnectionInfo, secret credentials.Secret, alias string) (string, error) {
	cfg := info.Config.Mongo
	if cfg == nil || !cfg.ExperimentalConsent {
		return "", models.NewError(models.CodeInvalidArgument, "Accept the experimental MongoDB notice before connecting", nil)
	}
	if err := manager.Ensure(ctx, conn, "mongo"); err != nil {
		return "", err
	}
	uri, err := buildMongoURI(*cfg, secret)
	if err != nil {
		return "", models.NewError(models.CodeInvalidArgument, "MongoDB configuration is invalid", nil)
	}
	secretName := ""
	attachPath := uri
	options := []string{"TYPE MONGO", "READ_ONLY"}
	// Recent mongo extension builds support temporary DuckDB secrets. Prefer
	// them when the host shape can be represented; older builds fail CREATE
	// SECRET and safely fall back to the in-memory URI path.
	if createSecret, name, optionPath, ok := buildMongoSecret(info, secret, alias); ok {
		_, _ = conn.ExecContext(ctx, "DROP SECRET IF EXISTS "+database.QuoteIdentifier(name))
		if _, createErr := conn.ExecContext(ctx, createSecret); createErr == nil {
			secretName = name
			attachPath = optionPath
			options = append(options, "SECRET "+database.QuoteIdentifier(name))
		}
	}
	statement := "ATTACH " + database.QuoteStringLiteral(attachPath) + " AS " + database.QuoteIdentifier(alias) + " (" + strings.Join(options, ", ") + ")"
	if _, err := conn.ExecContext(ctx, statement); err != nil {
		if secretName != "" {
			_, _ = conn.ExecContext(context.Background(), "DROP SECRET IF EXISTS "+database.QuoteIdentifier(secretName))
		}
		return "", models.NewError(models.CodeConnectionFailed, providerFailureMessage(KindMongo, err), nil)
	}
	var schemas int64
	if err := conn.QueryRowContext(ctx, `SELECT COUNT(*) FROM information_schema.schemata WHERE catalog_name = ?`, alias).Scan(&schemas); err != nil {
		_, _ = conn.ExecContext(context.Background(), "DETACH "+database.QuoteIdentifier(alias))
		if secretName != "" {
			_, _ = conn.ExecContext(context.Background(), "DROP SECRET IF EXISTS "+database.QuoteIdentifier(secretName))
		}
		return "", models.NewError(models.CodeConnectionFailed, "MongoDB connected but its catalog could not be read", nil)
	}
	return secretName, nil
}

func buildMongoSecret(info ConnectionInfo, secret credentials.Secret, alias string) (string, string, string, bool) {
	cfg := info.Config.Mongo
	if cfg == nil || len(cfg.Hosts) != 1 {
		return "", "", "", false
	}
	host, port := cfg.Hosts[0], "27017"
	if cfg.Mode == "mongodb" {
		if strings.HasPrefix(host, "[") {
			return "", "", "", false
		}
		if splitHost, splitPort, err := net.SplitHostPort(host); err == nil {
			host, port = splitHost, splitPort
		} else if strings.Count(host, ":") == 1 {
			parts := strings.SplitN(host, ":", 2)
			host, port = parts[0], parts[1]
		}
	}
	name := internalName("ducs_mongo", info.ID+"_"+alias)
	fields := []string{"TYPE mongo", "HOST " + database.QuoteStringLiteral(host), "DATABASE " + database.QuoteStringLiteral(cfg.Database)}
	if cfg.Mode == "mongodb" {
		fields = append(fields, "PORT "+database.QuoteStringLiteral(port))
	} else {
		fields = append(fields, "SRV 'true'")
	}
	if cfg.Username != "" {
		fields = append(fields, "USER "+database.QuoteStringLiteral(cfg.Username))
	}
	if secret.Password != "" {
		fields = append(fields, "PASSWORD "+database.QuoteStringLiteral(secret.Password))
	}
	if cfg.AuthSource != "" {
		fields = append(fields, "AUTHSOURCE "+database.QuoteStringLiteral(cfg.AuthSource))
	}
	if cfg.TLS {
		fields = append(fields, "TLS 'true'")
	}
	extra := url.Values{}
	if cfg.ReplicaSet != "" {
		extra.Set("replicaSet", cfg.ReplicaSet)
	}
	if cfg.DirectConnection {
		extra.Set("directConnection", "true")
	}
	if cfg.ReadPreference != "" {
		extra.Set("readPreference", cfg.ReadPreference)
	}
	extra.Set("connectTimeoutMS", strconv.Itoa(cfg.ConnectTimeoutSeconds*1000))
	optionPath := "mongodb://options.invalid/?" + extra.Encode()
	return "CREATE SECRET " + database.QuoteIdentifier(name) + " (" + strings.Join(fields, ", ") + ")", name, optionPath, true
}

func detachMongo(ctx context.Context, conn *sql.Conn, catalog, secretName string) error {
	_, detachErr := conn.ExecContext(ctx, "DETACH "+database.QuoteIdentifier(catalog))
	if secretName != "" {
		_, _ = conn.ExecContext(ctx, "DROP SECRET IF EXISTS "+database.QuoteIdentifier(secretName))
	}
	if detachErr != nil {
		return models.NewError(models.CodeConnectionFailed, "MongoDB could not be disconnected cleanly", nil)
	}
	return nil
}
