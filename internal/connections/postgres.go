package connections

import (
	"context"
	"database/sql"
	"fmt"
	"strings"

	"ducs-table/internal/credentials"
	"ducs-table/internal/database"
	"ducs-table/internal/extensions"
	"ducs-table/internal/models"
)

type postgresPlan struct{ secretName, createSecret, attach, configurePool, health string }

func buildPostgresPlan(info ConnectionInfo, secret credentials.Secret, alias string) postgresPlan {
	cfg := info.Config.Postgres
	secretName := internalName("ducs_pg", info.ID+"_"+alias)
	fields := []string{
		"TYPE postgres",
		"HOST " + database.QuoteStringLiteral(cfg.Host),
		fmt.Sprintf("PORT %d", cfg.Port),
		"DATABASE " + database.QuoteStringLiteral(cfg.Database),
		"USER " + database.QuoteStringLiteral(cfg.Username),
		"PASSWORD " + database.QuoteStringLiteral(secret.Password),
	}
	create := "CREATE SECRET " + database.QuoteIdentifier(secretName) + " (" + strings.Join(fields, ", ") + ")"
	options := []string{"TYPE postgres", "SECRET " + database.QuoteIdentifier(secretName), "READ_ONLY"}
	if cfg.Schema != "" {
		options = append(options, "SCHEMA "+database.QuoteStringLiteral(cfg.Schema))
	}
	attachConfig := fmt.Sprintf("connect_timeout=%d sslmode=%s", cfg.ConnectTimeoutSeconds, cfg.SSLMode)
	attach := "ATTACH " + database.QuoteStringLiteral(attachConfig) + " AS " + database.QuoteIdentifier(alias) + " (" + strings.Join(options, ", ") + ")"
	pool := "FROM postgres_configure_pool(catalog_name = " + database.QuoteStringLiteral(alias) +
		", acquire_mode = 'wait', max_connections = " + fmt.Sprint(cfg.PoolSize) +
		", wait_timeout_millis = " + fmt.Sprint(cfg.ConnectTimeoutSeconds*1000) +
		", idle_timeout_millis = 60000, enable_reaper_thread = true, health_check_query = 'SELECT 1')"
	return postgresPlan{secretName: secretName, createSecret: create, attach: attach, configurePool: pool,
		health: "SELECT COUNT(*) FROM information_schema.schemata WHERE catalog_name = ?"}
}

func attachPostgres(ctx context.Context, conn *sql.Conn, manager *extensions.Manager, info ConnectionInfo, secret credentials.Secret, alias string) (string, error) {
	if err := manager.Ensure(ctx, conn, "postgres"); err != nil {
		return "", err
	}
	plan := buildPostgresPlan(info, secret, alias)
	_, _ = conn.ExecContext(ctx, "DROP SECRET IF EXISTS "+database.QuoteIdentifier(plan.secretName))
	if _, err := conn.ExecContext(ctx, plan.createSecret); err != nil {
		return "", models.NewError(models.CodeConnectionFailed, "PostgreSQL credentials could not be prepared", nil)
	}
	cleanup := func() {
		_, _ = conn.ExecContext(context.Background(), "DETACH "+database.QuoteIdentifier(alias))
		_, _ = conn.ExecContext(context.Background(), "DROP SECRET IF EXISTS "+database.QuoteIdentifier(plan.secretName))
	}
	if _, err := conn.ExecContext(ctx, plan.attach); err != nil {
		cleanup()
		return "", models.NewError(models.CodeConnectionFailed, providerFailureMessage(KindPostgres, err), nil)
	}
	// Pool tuning was added after some supported DuckDB extension builds. It is
	// best-effort: older builds keep their internal defaults instead of turning
	// an otherwise healthy attachment into a connection failure.
	configurePostgresPool(ctx, conn, plan.configurePool)
	var schemas int64
	if err := conn.QueryRowContext(ctx, plan.health, alias).Scan(&schemas); err != nil {
		cleanup()
		return "", models.NewError(models.CodeConnectionFailed, "PostgreSQL connected but its catalog could not be read", nil)
	}
	return plan.secretName, nil
}

func configurePostgresPool(ctx context.Context, conn *sql.Conn, configureSQL string) bool {
	var available bool
	if err := conn.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM duckdb_functions() WHERE function_name = 'postgres_configure_pool')`).Scan(&available); err != nil || !available {
		return false
	}
	var configured int64
	return conn.QueryRowContext(ctx, "SELECT COUNT(*) "+configureSQL).Scan(&configured) == nil
}

func detachPostgres(ctx context.Context, conn *sql.Conn, catalog, secretName string) error {
	_, detachErr := conn.ExecContext(ctx, "DETACH "+database.QuoteIdentifier(catalog))
	if secretName != "" {
		_, _ = conn.ExecContext(ctx, "DROP SECRET IF EXISTS "+database.QuoteIdentifier(secretName))
	}
	if detachErr != nil {
		return models.NewError(models.CodeConnectionFailed, "PostgreSQL could not be disconnected cleanly", nil)
	}
	return nil
}
