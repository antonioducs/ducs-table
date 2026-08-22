package connections

import (
	"net"
	"strconv"
	"strings"
	"unicode/utf8"

	"ducs-table/internal/database"
	"ducs-table/internal/models"
)

var reservedCatalogs = map[string]struct{}{
	"data": {}, "result": {}, "main": {}, "temp": {}, "ducs_meta": {},
	"information_schema": {}, "pg_catalog": {}, "system": {},
}

func normalizeCatalogName(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", models.NewError(models.CodeInvalidArgument, "SQL catalog alias is required", nil)
	}
	name := database.NormalizeIdentifier(value)
	if utf8.RuneCountInString(name) > 63 {
		return "", models.NewError(models.CodeInvalidArgument, "SQL catalog alias is too long", map[string]any{"maxLength": 63})
	}
	if _, reserved := reservedCatalogs[name]; reserved {
		return "", models.NewError(models.CodeInvalidArgument, "This SQL catalog alias is reserved", map[string]any{"catalogName": name})
	}
	return name, nil
}

func validateConnection(info ConnectionInfo) (ConnectionInfo, error) {
	info.Name = strings.TrimSpace(info.Name)
	if info.Name == "" {
		return ConnectionInfo{}, models.NewError(models.CodeInvalidArgument, "Connection name is required", nil)
	}
	if utf8.RuneCountInString(info.Name) > 200 {
		return ConnectionInfo{}, models.NewError(models.CodeInvalidArgument, "Connection name is too long", map[string]any{"maxLength": 200})
	}
	alias, err := normalizeCatalogName(info.CatalogName)
	if err != nil {
		return ConnectionInfo{}, err
	}
	info.CatalogName = alias
	switch info.Kind {
	case KindPostgres:
		if info.Config.Postgres == nil || info.Config.Mongo != nil {
			return ConnectionInfo{}, models.NewError(models.CodeInvalidArgument, "PostgreSQL configuration is required", nil)
		}
		cfg := *info.Config.Postgres
		cfg.Host = strings.TrimSpace(cfg.Host)
		cfg.Database = strings.TrimSpace(cfg.Database)
		cfg.Username = strings.TrimSpace(cfg.Username)
		cfg.Schema = strings.TrimSpace(cfg.Schema)
		if cfg.Host == "" || cfg.Database == "" || cfg.Username == "" {
			return ConnectionInfo{}, models.NewError(models.CodeInvalidArgument, "PostgreSQL host, database, and username are required", nil)
		}
		if strings.ContainsAny(cfg.Host+cfg.Database+cfg.Username+cfg.Schema, "\x00\r\n") {
			return ConnectionInfo{}, models.NewError(models.CodeInvalidArgument, "PostgreSQL host is invalid", nil)
		}
		if cfg.Port == 0 {
			cfg.Port = 5432
		}
		if cfg.Port < 1 || cfg.Port > 65535 {
			return ConnectionInfo{}, models.NewError(models.CodeInvalidArgument, "PostgreSQL port is invalid", nil)
		}
		cfg.SSLMode = strings.ToLower(strings.TrimSpace(cfg.SSLMode))
		if cfg.SSLMode == "" {
			cfg.SSLMode = "prefer"
		}
		allowedSSL := map[string]bool{"disable": true, "allow": true, "prefer": true, "require": true, "verify-ca": true, "verify-full": true}
		if !allowedSSL[cfg.SSLMode] {
			return ConnectionInfo{}, models.NewError(models.CodeInvalidArgument, "PostgreSQL SSL mode is invalid", nil)
		}
		boundRuntime(&cfg.ConnectTimeoutSeconds, &cfg.PoolSize)
		info.Config.Postgres = &cfg
	case KindMongo:
		if info.Config.Mongo == nil || info.Config.Postgres != nil {
			return ConnectionInfo{}, models.NewError(models.CodeInvalidArgument, "MongoDB configuration is required", nil)
		}
		cfg := *info.Config.Mongo
		cfg.Mode = strings.ToLower(strings.TrimSpace(cfg.Mode))
		if cfg.Mode == "" {
			cfg.Mode = "mongodb"
		}
		if cfg.Mode != "mongodb" && cfg.Mode != "mongodb+srv" {
			return ConnectionInfo{}, models.NewError(models.CodeInvalidArgument, "MongoDB connection mode is invalid", nil)
		}
		cfg.Database = strings.TrimSpace(cfg.Database)
		cfg.Username = strings.TrimSpace(cfg.Username)
		cfg.AuthSource = strings.TrimSpace(cfg.AuthSource)
		cfg.ReplicaSet = strings.TrimSpace(cfg.ReplicaSet)
		if cfg.Database == "" || len(cfg.Hosts) == 0 {
			return ConnectionInfo{}, models.NewError(models.CodeInvalidArgument, "MongoDB hosts and database are required", nil)
		}
		if strings.ContainsAny(cfg.Database, "/\\. \x00\r\n?#") {
			return ConnectionInfo{}, models.NewError(models.CodeInvalidArgument, "MongoDB database name is invalid", nil)
		}
		cleanHosts := make([]string, 0, len(cfg.Hosts))
		for _, host := range cfg.Hosts {
			host = strings.TrimSpace(host)
			if host == "" || strings.ContainsAny(host, "@/?#,\x00\r\n ") {
				return ConnectionInfo{}, models.NewError(models.CodeInvalidArgument, "MongoDB host is invalid", nil)
			}
			if cfg.Mode == "mongodb+srv" && strings.Contains(host, ":") {
				return ConnectionInfo{}, models.NewError(models.CodeInvalidArgument, "MongoDB SRV host cannot include a port", nil)
			}
			if cfg.Mode == "mongodb" {
				colonCount := strings.Count(host, ":")
				if colonCount > 1 && !strings.HasPrefix(host, "[") {
					return ConnectionInfo{}, models.NewError(models.CodeInvalidArgument, "MongoDB IPv6 hosts must use brackets and include a port", nil)
				}
				if colonCount > 0 || strings.HasPrefix(host, "[") {
					_, port, splitErr := net.SplitHostPort(host)
					if splitErr != nil {
						return ConnectionInfo{}, models.NewError(models.CodeInvalidArgument, "MongoDB host port is invalid", nil)
					}
					if n, parseErr := strconv.Atoi(port); parseErr != nil || n < 1 || n > 65535 {
						return ConnectionInfo{}, models.NewError(models.CodeInvalidArgument, "MongoDB port is invalid", nil)
					}
				}
			}
			cleanHosts = append(cleanHosts, host)
		}
		cfg.Hosts = cleanHosts
		if cfg.Mode == "mongodb+srv" && len(cfg.Hosts) != 1 {
			return ConnectionInfo{}, models.NewError(models.CodeInvalidArgument, "MongoDB SRV mode requires exactly one host", nil)
		}
		if cfg.DirectConnection && len(cfg.Hosts) != 1 {
			return ConnectionInfo{}, models.NewError(models.CodeInvalidArgument, "MongoDB direct connection requires exactly one host", nil)
		}
		readPreferences := map[string]string{"primary": "primary", "primarypreferred": "primaryPreferred", "secondary": "secondary", "secondarypreferred": "secondaryPreferred", "nearest": "nearest"}
		if cfg.ReadPreference == "" {
			cfg.ReadPreference = "secondaryPreferred"
		}
		canonicalRead, ok := readPreferences[strings.ToLower(strings.TrimSpace(cfg.ReadPreference))]
		if !ok {
			return ConnectionInfo{}, models.NewError(models.CodeInvalidArgument, "MongoDB read preference is invalid", nil)
		}
		cfg.ReadPreference = canonicalRead
		if cfg.ConnectTimeoutSeconds == 0 {
			cfg.ConnectTimeoutSeconds = 10
		}
		if cfg.ConnectTimeoutSeconds < 1 || cfg.ConnectTimeoutSeconds > 60 {
			return ConnectionInfo{}, models.NewError(models.CodeInvalidArgument, "Connection timeout must be between 1 and 60 seconds", nil)
		}
		info.Config.Mongo = &cfg
	default:
		return ConnectionInfo{}, models.NewError(models.CodeInvalidArgument, "Connection provider is invalid", nil)
	}
	return info, nil
}

func boundRuntime(timeout, pool *int) {
	if *timeout == 0 {
		*timeout = 10
	}
	if *pool == 0 {
		*pool = 4
	}
}

func validateRuntimeBounds(info ConnectionInfo) error {
	if info.Kind == KindPostgres {
		cfg := info.Config.Postgres
		if cfg.ConnectTimeoutSeconds < 1 || cfg.ConnectTimeoutSeconds > 60 {
			return models.NewError(models.CodeInvalidArgument, "Connection timeout must be between 1 and 60 seconds", nil)
		}
		if cfg.PoolSize < 1 || cfg.PoolSize > 8 {
			return models.NewError(models.CodeInvalidArgument, "PostgreSQL pool size must be between 1 and 8", nil)
		}
	}
	return nil
}
