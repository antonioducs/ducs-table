package grid

import (
	"context"
	"database/sql"
	"path/filepath"
	"strings"
	"testing"

	"ducs-table/internal/database"
	"ducs-table/internal/models"
	"ducs-table/internal/workspace"
)

type fakeExternalResolver struct {
	db        *database.DB
	relation  models.ExternalRelationInfo
	withCalls int
	projectID string
}

func (f *fakeExternalResolver) ResolveExternal(_ context.Context, projectID, _ string) (models.ExternalRelationInfo, error) {
	f.projectID = projectID
	return f.relation, nil
}
func (f *fakeExternalResolver) WithFederatedConn(ctx context.Context, fn func(*sql.Conn) error) error {
	f.withCalls++
	conn, err := f.db.SQL().Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	return fn(conn)
}

func liveGridProjectID(t *testing.T, db *database.DB) string {
	t.Helper()
	project, err := workspace.New(db).InitialProject(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if project.Name != "My Workspace" {
		t.Fatalf("initial project = %q, want My Workspace", project.Name)
	}
	return project.ID
}

func TestLiveGridUsesLimitPlusOneWithoutCountOrRowID(t *testing.T) {
	ctx := context.Background()
	db, err := database.OpenPath(ctx, filepath.Join(t.TempDir(), "workspace.duckdb"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	projectID := liveGridProjectID(t, db)
	if _, err := db.SQL().ExecContext(ctx, `CREATE TABLE main.live_rows(id INTEGER, value VARCHAR)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.SQL().ExecContext(ctx, `INSERT INTO main.live_rows VALUES (1,'a'),(2,'b'),(3,'c'),(4,'d')`); err != nil {
		t.Fatal(err)
	}
	resolver := &fakeExternalResolver{db: db, relation: models.ExternalRelationInfo{ID: "relation", ConnectionID: "connection", Catalog: "remote", Schema: "public", Name: "rows", QualifiedName: database.QuoteQualified("main", "live_rows"), Columns: []models.ColumnInfo{{Name: "id", Type: "INTEGER", Ordinal: 1}, {Name: "value", Type: "VARCHAR", Ordinal: 2}}, DefaultOrder: []string{"id"}, PagingStable: true}}
	service := New(db)
	service.SetExternalResolver(resolver)
	resource := models.GridResourceRef{Kind: "external", RelationID: "relation"}
	built, err := service.BuildSelect(ctx, SelectRequest{ProjectID: projectID, Resource: resource, Limit: 2}, true)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(strings.ToLower(built.SQL), "rowid") || strings.Contains(strings.ToLower(built.SQL), "count(") {
		t.Fatalf("live SQL contains forbidden paging behavior: %s", built.SQL)
	}
	if got := built.Args[len(built.Args)-2]; got != 3 {
		t.Fatalf("fetch limit = %v, want requested+1", got)
	}
	response, err := service.Rows(ctx, RowsRequest{ProjectID: projectID, Resource: resource, Limit: 2})
	if err != nil {
		t.Fatal(err)
	}
	if len(response.Rows) != 2 || !response.HasMore || response.TotalRows != nil || !response.PagingStable {
		t.Fatalf("unexpected live response: %+v", response)
	}
	if resolver.withCalls != 1 {
		t.Fatalf("remote block ran %d queries, want one", resolver.withCalls)
	}
	if resolver.projectID != projectID {
		t.Fatalf("resolver project = %q, want %q", resolver.projectID, projectID)
	}
	if _, err := service.Rows(ctx, RowsRequest{ProjectID: projectID, Resource: resource, Limit: 2, Sorts: []Sort{{Column: "unknown", Direction: "asc"}}}); err == nil {
		t.Fatal("unknown external sort column was accepted")
	}
}

func TestLiveGridMarksUnstablePagingWithoutInventingOrder(t *testing.T) {
	ctx := context.Background()
	db, err := database.OpenPath(ctx, filepath.Join(t.TempDir(), "workspace.duckdb"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	projectID := liveGridProjectID(t, db)
	if _, err := db.SQL().ExecContext(ctx, `CREATE TABLE main.live_unstable(id INTEGER)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.SQL().ExecContext(ctx, `INSERT INTO main.live_unstable VALUES (1),(2)`); err != nil {
		t.Fatal(err)
	}
	resolver := &fakeExternalResolver{db: db, relation: models.ExternalRelationInfo{ID: "unstable", ConnectionID: "connection", QualifiedName: database.QuoteQualified("main", "live_unstable"), Columns: []models.ColumnInfo{{Name: "id", Type: "INTEGER", Ordinal: 1}}}}
	service := New(db)
	service.SetExternalResolver(resolver)
	resource := models.GridResourceRef{Kind: "external", RelationID: "unstable"}
	built, err := service.BuildSelect(ctx, SelectRequest{ProjectID: projectID, Resource: resource, Limit: 10}, true)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(strings.ToUpper(built.SQL), "ORDER BY") {
		t.Fatalf("unstable relation received invented order: %s", built.SQL)
	}
	response, err := service.Rows(ctx, RowsRequest{ProjectID: projectID, Resource: resource, Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if response.PagingStable {
		t.Fatal("unstable relation was reported stable")
	}
}

func TestPostgresGridPushesUnfilteredPageIntoRemoteQuery(t *testing.T) {
	ctx := context.Background()
	db, err := database.OpenPath(ctx, filepath.Join(t.TempDir(), "workspace.duckdb"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	projectID := liveGridProjectID(t, db)
	resolver := &fakeExternalResolver{db: db, relation: models.ExternalRelationInfo{
		ID: "postgres-relation", ConnectionID: "connection", Provider: "postgres", Catalog: "prod",
		Schema: "public", Name: "stock", QualifiedName: database.QuoteQualified("prod", "public", "stock"),
		Columns:      []models.ColumnInfo{{Name: "id", Type: "BIGINT", Ordinal: 1}, {Name: "sku", Type: "VARCHAR", Ordinal: 2}},
		DefaultOrder: []string{"id"}, PagingStable: true,
	}}
	service := New(db)
	service.SetExternalResolver(resolver)

	built, err := service.BuildSelect(ctx, SelectRequest{
		ProjectID: projectID,
		Resource:  models.GridResourceRef{Kind: "external", RelationID: "postgres-relation"},
		Columns:   []string{"sku", "id"}, Offset: 500, Limit: 100,
	}, true)
	if err != nil {
		t.Fatal(err)
	}
	if built.SQL != "SELECT * FROM postgres_query(?, ?)" {
		t.Fatalf("grid SQL = %q", built.SQL)
	}
	if len(built.Args) != 2 || built.Args[0] != "prod" {
		t.Fatalf("grid args = %#v", built.Args)
	}
	remoteSQL, ok := built.Args[1].(string)
	if !ok {
		t.Fatalf("remote SQL arg = %T, want string", built.Args[1])
	}
	want := `SELECT t."sku", t."id" FROM "public"."stock" AS t ORDER BY t."id" ASC NULLS LAST LIMIT 101 OFFSET 500`
	if remoteSQL != want {
		t.Fatalf("remote SQL = %q, want %q", remoteSQL, want)
	}

	filtered, err := service.BuildSelect(ctx, SelectRequest{
		ProjectID: projectID,
		Resource:  models.GridResourceRef{Kind: "external", RelationID: "postgres-relation"},
		Filters:   []Filter{{Column: "sku", Type: "text", Operator: "contains", Value: "ABC"}},
		Limit:     100,
	}, true)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(filtered.SQL, "postgres_query") {
		t.Fatalf("filtered grid unexpectedly used native PostgreSQL SQL: %s", filtered.SQL)
	}
}
