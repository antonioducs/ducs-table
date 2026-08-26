package workspace_test

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"ducs-table/internal/apppaths"
	"ducs-table/internal/database"
	"ducs-table/internal/models"
	"ducs-table/internal/workspace"
)

func TestProjectCRUDArchiveRestoreAndConnections(t *testing.T) {
	ctx, db, service, initial := testWorkspace(t)
	if initial.Name != "My Workspace" {
		t.Fatalf("initial project = %#v", initial)
	}

	analytics, err := service.CreateProject(ctx, "  Analytics  ", "Shared reports")
	if err != nil {
		t.Fatal(err)
	}
	if analytics.Name != "Analytics" || analytics.Description != "Shared reports" {
		t.Fatalf("created project = %#v", analytics)
	}
	if _, err := service.CreateProject(ctx, "analytics", "duplicate"); errorCode(err) != models.CodeConflict {
		t.Fatalf("duplicate project error = %#v", err)
	}
	analytics, err = service.UpdateProject(ctx, analytics.ID, "Analysis", "Updated")
	if err != nil {
		t.Fatal(err)
	}
	if analytics.Name != "Analysis" || analytics.Description != "Updated" {
		t.Fatalf("updated project = %#v", analytics)
	}

	if _, err := service.OpenProject(ctx, initial.ID); err != nil {
		t.Fatal(err)
	}
	time.Sleep(2 * time.Millisecond)
	opened, err := service.OpenProject(ctx, analytics.ID)
	if err != nil {
		t.Fatal(err)
	}
	if opened.LastOpenedAt == nil {
		t.Fatal("open did not set last_opened_at")
	}
	selected, err := service.InitialProject(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if selected.ID != analytics.ID {
		t.Fatalf("initial project = %q, want %q", selected.ID, analytics.ID)
	}

	archived, err := service.ArchiveProject(ctx, analytics.ID)
	if err != nil {
		t.Fatal(err)
	}
	if archived.ArchivedAt == nil {
		t.Fatal("archive timestamp was not set")
	}
	if _, err := service.OpenProject(ctx, analytics.ID); errorCode(err) != models.CodeProjectArchived {
		t.Fatalf("open archived project error = %#v", err)
	}
	active, err := service.ListProjects(ctx, false)
	if err != nil || len(active) != 1 || active[0].ID != initial.ID {
		t.Fatalf("active projects = %#v, err=%v", active, err)
	}
	all, err := service.ListProjects(ctx, true)
	if err != nil || len(all) != 2 {
		t.Fatalf("all projects = %#v, err=%v", all, err)
	}
	analytics, err = service.RestoreProject(ctx, analytics.ID)
	if err != nil || analytics.ArchivedAt != nil {
		t.Fatalf("restored project = %#v, err=%v", analytics, err)
	}
	if _, err := service.ArchiveProject(ctx, initial.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := service.ArchiveProject(ctx, analytics.ID); errorCode(err) != models.CodeConflict {
		t.Fatalf("archiving final project error = %#v", err)
	}
	if _, err := service.RestoreProject(ctx, initial.ID); err != nil {
		t.Fatal(err)
	}

	insertConnection(t, db, "conn-1")
	if err := service.AttachConnection(ctx, initial.ID, "conn-1"); err != nil {
		t.Fatal(err)
	}
	if err := service.AttachConnection(ctx, initial.ID, "conn-1"); err != nil {
		t.Fatal("duplicate attach was not idempotent:", err)
	}
	if err := service.AttachConnection(ctx, analytics.ID, "conn-1"); err != nil {
		t.Fatal(err)
	}
	usage, err := service.ConnectionUsageCount(ctx, "conn-1")
	if err != nil || usage != 2 {
		t.Fatalf("connection usage = %d, err=%v", usage, err)
	}
	ids, err := service.ListConnectionIDs(ctx, initial.ID)
	if err != nil || len(ids) != 1 || ids[0] != "conn-1" {
		t.Fatalf("connection IDs = %#v, err=%v", ids, err)
	}
	if err := service.DetachConnection(ctx, initial.ID, "conn-1"); err != nil {
		t.Fatal(err)
	}
	usage, err = service.ConnectionUsageCount(ctx, "conn-1")
	if err != nil || usage != 1 {
		t.Fatalf("connection usage after detach = %d, err=%v", usage, err)
	}
}

func TestSourcesAndSavedQueriesAreStrictlyProjectScoped(t *testing.T) {
	ctx, db, service, first := testWorkspace(t)
	second, err := service.CreateProject(ctx, "Second", "")
	if err != nil {
		t.Fatal(err)
	}
	source := insertSource(t, db, first.ID, "source-1", "data", "people_project_one", false)

	got, err := service.GetDataset(ctx, first.ID, source.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.ProjectID != first.ID || got.RowCount != 1 || len(got.Columns) != 1 {
		t.Fatalf("source = %#v", got)
	}
	if _, err := service.GetSource(ctx, second.ID, source.ID); errorCode(err) != models.CodeSourceNotFound {
		t.Fatalf("cross-project source read error = %#v", err)
	}
	renamed, err := service.RenameSource(ctx, first.ID, source.ID, "  People report  ")
	if err != nil {
		t.Fatal(err)
	}
	if renamed.DisplayName != "People report" || renamed.SQLName != source.SQLName {
		t.Fatalf("renamed source = %#v", renamed)
	}
	if _, err := service.RenameSource(ctx, second.ID, source.ID, "Stolen"); errorCode(err) != models.CodeSourceNotFound {
		t.Fatalf("cross-project source rename error = %#v", err)
	}
	if _, err := service.RenameSource(ctx, first.ID, source.ID, "   "); errorCode(err) != models.CodeInvalidArgument {
		t.Fatalf("empty source name error = %#v", err)
	}

	firstQuery, err := service.CreateSavedQuery(ctx, first.ID, "Adults", `SELECT * FROM data.people_project_one`)
	if err != nil {
		t.Fatal(err)
	}
	secondQuery, err := service.CreateSavedQuery(ctx, second.ID, "adults", `SELECT 2`)
	if err != nil {
		t.Fatal("same name in another project failed:", err)
	}
	if _, err := service.CreateSavedQuery(ctx, first.ID, "ADULTS", `SELECT 3`); errorCode(err) != models.CodeConflict {
		t.Fatalf("same-project duplicate error = %#v", err)
	}
	updated, err := service.UpdateSavedQuery(ctx, first.ID, firstQuery.ID, "Adults 21+", `SELECT 21`)
	if err != nil {
		t.Fatal(err)
	}
	if updated.ProjectID != first.ID || updated.Name != "Adults 21+" {
		t.Fatalf("updated query = %#v", updated)
	}
	if _, err := service.UpdateSavedQuery(ctx, second.ID, firstQuery.ID, "Stolen", `SELECT 1`); errorCode(err) != models.CodeNotFound {
		t.Fatalf("cross-project query update error = %#v", err)
	}
	queries, err := service.ListSavedQueries(ctx, second.ID)
	if err != nil || len(queries) != 1 || queries[0].ID != secondQuery.ID {
		t.Fatalf("second project queries = %#v, err=%v", queries, err)
	}

	boot, err := service.Bootstrap(ctx, first.ID)
	if err != nil {
		t.Fatal(err)
	}
	if boot.Project.ID != first.ID || len(boot.Sources) != 1 || len(boot.Datasets) != 1 || len(boot.Results) != 0 || len(boot.SavedQueries) != 1 {
		t.Fatalf("bootstrap = %#v", boot)
	}
	if err := service.DeleteSavedQuery(ctx, first.ID, firstQuery.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := service.GetSavedQuery(ctx, first.ID, firstQuery.ID); errorCode(err) != models.CodeNotFound {
		t.Fatalf("deleted query error = %#v", err)
	}

	if err := service.RemoveDataset(ctx, second.ID, source.ID); errorCode(err) != models.CodeSourceNotFound {
		t.Fatalf("cross-project removal error = %#v", err)
	}
	exists, err := database.TableExists(ctx, db.SQL(), source.Schema, source.SQLName)
	if err != nil || !exists {
		t.Fatalf("cross-project removal touched table: exists=%v err=%v", exists, err)
	}
	if err := service.RemoveDataset(ctx, first.ID, source.ID); err != nil {
		t.Fatal(err)
	}
	exists, err = database.TableExists(ctx, db.SQL(), source.Schema, source.SQLName)
	if err != nil || exists {
		t.Fatalf("dataset table exists=%v err=%v", exists, err)
	}
}

func testWorkspace(t *testing.T) (context.Context, *database.DB, *workspace.Service, models.Project) {
	t.Helper()
	paths, err := apppaths.ResolveAt(filepath.Join(t.TempDir(), "state"))
	if err != nil {
		t.Fatal(err)
	}
	db, err := database.Open(context.Background(), paths)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	service := workspace.New(db)
	project, err := service.InitialProject(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return context.Background(), db, service, project
}

func insertSource(t *testing.T, db *database.DB, projectID, id, schema, sqlName string, ephemeral bool) models.SourceInfo {
	t.Helper()
	now := time.Date(2025, 1, 2, 3, 4, 5, 0, time.UTC)
	source := models.SourceInfo{
		ID: id, ProjectID: projectID, DisplayName: id, SQLName: sqlName,
		Schema: schema, SourceType: "test", RowCount: 1, IsEphemeral: ephemeral,
		CreatedAt: now, UpdatedAt: now,
	}
	err := db.WithTx(context.Background(), func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(context.Background(), "CREATE TABLE "+database.QuoteQualified(schema, sqlName)+" AS SELECT 1 AS value"); err != nil {
			return err
		}
		return workspace.InsertSourceTx(context.Background(), tx, projectID, source)
	})
	if err != nil {
		t.Fatal(err)
	}
	return source
}

func insertConnection(t *testing.T, db *database.DB, id string) {
	t.Helper()
	_, err := db.SQL().ExecContext(context.Background(), `
		INSERT INTO ducs_meta.connections (id, name, kind, catalog_name, config_json)
		VALUES (?, ?, 'postgres', ?, '{}')`, id, id, "catalog_"+id)
	if err != nil {
		t.Fatal(err)
	}
}

func errorCode(err error) string {
	var appErr *models.AppError
	if errors.As(err, &appErr) {
		return appErr.Code
	}
	return ""
}
