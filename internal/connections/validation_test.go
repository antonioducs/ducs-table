package connections

import (
	"errors"
	"strings"
	"testing"

	"ducs-table/internal/credentials"
)

func validPostgresInfo() ConnectionInfo {
	return ConnectionInfo{Name: "Production", Kind: KindPostgres, CatalogName: "Prod DB", Config: ConnectionConfig{Postgres: &PostgresConfig{Host: "localhost", Port: 5432, Database: "app", Username: "reader", SSLMode: "require", ConnectTimeoutSeconds: 10, PoolSize: 4}}}
}

func TestCatalogAliasNormalizationReservedAndRuntimeBounds(t *testing.T) {
	info, err := validateConnection(validPostgresInfo())
	if err != nil {
		t.Fatal(err)
	}
	if info.CatalogName != "prod_db" {
		t.Fatalf("catalog = %q", info.CatalogName)
	}
	if err := validateRuntimeBounds(info); err != nil {
		t.Fatal(err)
	}
	reserved := validPostgresInfo()
	reserved.CatalogName = "DUCS META"
	if _, err := validateConnection(reserved); err == nil {
		t.Fatal("reserved alias was accepted")
	}
	unsafe := validPostgresInfo()
	unsafe.CatalogName = `prod"; DROP SCHEMA data`
	normalized, err := validateConnection(unsafe)
	if err != nil {
		t.Fatal(err)
	}
	if strings.ContainsAny(normalized.CatalogName, `"; `) {
		t.Fatalf("unsafe alias = %q", normalized.CatalogName)
	}
	large := validPostgresInfo()
	large.Config.Postgres.PoolSize = 9
	large, err = validateConnection(large)
	if err != nil {
		t.Fatal(err)
	}
	if err := validateRuntimeBounds(large); err == nil {
		t.Fatal("oversized pool was accepted")
	}
}

func TestPostgresPlanIsReadOnlyAndPoolIsBounded(t *testing.T) {
	info := validPostgresInfo()
	info.ID = "connection-id"
	info.CatalogName = "prod"
	info, _ = validateConnection(info)
	plan := buildPostgresPlan(info, credentials.Secret{Password: "sensitive"}, info.CatalogName)
	if !strings.Contains(plan.attach, "READ_ONLY") || strings.Contains(plan.attach, "READ_WRITE") {
		t.Fatalf("attach is not read-only: %s", plan.attach)
	}
	if strings.Contains(strings.ToLower(plan.createSecret), "sslmode") || !strings.Contains(plan.attach, "sslmode=require") {
		t.Fatalf("SSL mode must be a non-secret ATTACH option: secret=%s attach=%s", plan.createSecret, plan.attach)
	}
	if !strings.Contains(plan.configurePool, "acquire_mode = 'wait'") || !strings.Contains(plan.configurePool, "max_connections = 4") || !strings.Contains(plan.configurePool, "enable_reaper_thread = true") {
		t.Fatalf("pool is not conservatively configured: %s", plan.configurePool)
	}
}

func TestMongoURIEscapingAndRedaction(t *testing.T) {
	cfg := MongoConfig{Mode: "mongodb", Hosts: []string{"db.example:27017"}, Database: "crm", Username: "user@example.com", AuthSource: "admin db", TLS: true, ReplicaSet: "rs/0", ReadPreference: "secondaryPreferred", ConnectTimeoutSeconds: 7}
	uri, err := buildMongoURI(cfg, credentials.Secret{Password: "p@ss:/?#&word"})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"user%40example.com", "p%40ss%3A%2F%3F%23%26word", "authSource=admin+db", "replicaSet=rs%2F0", "connectTimeoutMS=7000"} {
		if !strings.Contains(uri, want) {
			t.Fatalf("URI %q missing %q", uri, want)
		}
	}
	redacted := Redact("connect " + uri + " password=another-secret&token=third-secret")
	for _, secret := range []string{"p%40ss", "another-secret", "third-secret"} {
		if strings.Contains(redacted, secret) {
			t.Fatalf("redaction leaked %q in %q", secret, redacted)
		}
	}
}

func TestMongoPrefersTemporarySecretWhenSupported(t *testing.T) {
	info := ConnectionInfo{ID: "mongo-id", Kind: KindMongo, Config: ConnectionConfig{Mongo: &MongoConfig{Mode: "mongodb", Hosts: []string{"db.example:27018"}, Database: "crm", Username: "reader", AuthSource: "admin", TLS: true, ReadPreference: "secondaryPreferred", ConnectTimeoutSeconds: 10}}}
	statement, name, attachPath, ok := buildMongoSecret(info, credentials.Secret{Password: "mongo-secret"}, "catalog")
	if !ok || name == "" || !strings.Contains(statement, "CREATE SECRET") || !strings.Contains(statement, "TYPE mongo") || !strings.Contains(statement, "PASSWORD 'mongo-secret'") {
		t.Fatalf("unexpected Mongo secret plan: %q", statement)
	}
	if strings.Contains(attachPath, "mongo-secret") || strings.Contains(attachPath, "reader@") {
		t.Fatalf("attach path contains credentials: %q", attachPath)
	}
}

func TestProviderFailureMessagesAreActionableAndSanitized(t *testing.T) {
	tests := []struct {
		kind      ConnectionKind
		raw, want string
	}{
		{KindPostgres, "connection refused host=localhost password=do-not-leak", "refused the connection"},
		{KindPostgres, "password authentication failed for user reader password=do-not-leak", "rejected the username or password"},
		{KindMongo, "server selection timeout mongodb://user:do-not-leak@example/db", "timed out"},
		{KindMongo, "TLS certificate verify failed mongodb://user:do-not-leak@example/db", "TLS/SSL"},
	}
	for _, test := range tests {
		message := providerFailureMessage(test.kind, errors.New(test.raw))
		if !strings.Contains(message, test.want) {
			t.Fatalf("message %q missing %q", message, test.want)
		}
		if strings.Contains(message, "do-not-leak") || strings.Contains(message, "mongodb://") {
			t.Fatalf("message leaked connection input: %q", message)
		}
	}
}
