package query

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"testing"

	"ducs-table/internal/apppaths"
	"ducs-table/internal/database"
	"ducs-table/internal/grid"
	"ducs-table/internal/importers"
	"ducs-table/internal/models"
	"ducs-table/internal/workspace"
)

func queryFixture(t *testing.T) (*database.DB, apppaths.Paths, string, models.SourceInfo, models.SourceInfo) {
	t.Helper()
	ctx := context.Background()
	paths, err := apppaths.ResolveAt(filepath.Join(t.TempDir(), "state"))
	if err != nil {
		t.Fatal(err)
	}
	db, err := database.Open(ctx, paths)
	if err != nil {
		t.Fatal(err)
	}
	project, err := workspace.New(db).InitialProject(ctx)
	if err != nil {
		_ = db.Close()
		t.Fatal(err)
	}
	if project.Name != "My Workspace" {
		_ = db.Close()
		t.Fatalf("initial project = %q, want My Workspace", project.Name)
	}
	importer := importers.New(db)
	people, err := importer.Materialize(ctx, importers.MaterializeRequest{ProjectID: project.ID, Path: filepath.Join("..", "..", "testdata", "people.csv")})
	if err != nil {
		_ = db.Close()
		t.Fatal(err)
	}
	orders, err := importer.Materialize(ctx, importers.MaterializeRequest{ProjectID: project.ID, Path: filepath.Join("..", "..", "testdata", "orders.tsv")})
	if err != nil {
		_ = db.Close()
		t.Fatal(err)
	}
	return db, paths, project.ID, people, orders
}

func TestRunJoinSaveCopyMoveAndClose(t *testing.T) {
	db, _, projectID, people, orders := queryFixture(t)
	defer db.Close()
	ctx := context.Background()
	service := New(db)
	joinSQL := fmt.Sprintf(`
		SELECT p.name, COUNT(*) AS order_count, SUM(o.amount) AS total
		FROM %s AS p
		JOIN %s AS o ON p.id = o.person_id
		GROUP BY p.name
		ORDER BY p.name`,
		database.QuoteQualified(people.Schema, people.SQLName),
		database.QuoteQualified(orders.Schema, orders.SQLName))
	result, err := service.Run(ctx, projectID, joinSQL)
	if err != nil {
		t.Fatal(err)
	}
	if result.Source.ProjectID != projectID || result.Source.Schema != "result" || !result.Source.IsEphemeral || result.RowCount != 2 || len(result.Columns) != 3 {
		t.Fatalf("unexpected query result: %#v", result)
	}
	page, err := grid.New(db).Rows(ctx, grid.RowsRequest{ProjectID: projectID, SourceID: result.Source.ID, Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Rows) != 2 || page.Rows[0]["name"] != "Alice" {
		t.Fatalf("unexpected materialized rows: %#v", page.Rows)
	}

	copied, err := service.SaveResult(ctx, SaveResultRequest{ProjectID: projectID, ResultID: result.Source.ID, DisplayName: "Order totals", Copy: true})
	if err != nil {
		t.Fatal(err)
	}
	if copied.ProjectID != projectID || copied.Schema != "data" || copied.IsEphemeral || copied.ID == result.Source.ID {
		t.Fatalf("unexpected copied source: %#v", copied)
	}
	if _, err := workspace.New(db).GetSource(ctx, projectID, result.Source.ID); err != nil {
		t.Fatalf("copy removed original result: %v", err)
	}
	if err := service.CloseResult(ctx, projectID, result.Source.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := workspace.New(db).GetSource(ctx, projectID, copied.ID); err != nil {
		t.Fatalf("closing result removed persistent copy: %v", err)
	}

	moveResult, err := service.Run(ctx, projectID, `SELECT 1 AS id, 'semi;colon' AS label; -- trailing comment`)
	if err != nil {
		t.Fatal(err)
	}
	moved, err := service.SaveResultAsTable(ctx, projectID, moveResult.Source.ID, "Pinned result")
	if err != nil {
		t.Fatal(err)
	}
	if moved.ID != moveResult.Source.ID || moved.ProjectID != projectID || moved.Schema != "data" || moved.IsEphemeral {
		t.Fatalf("unexpected moved result: %#v", moved)
	}
	err = service.CloseResult(ctx, projectID, moved.ID)
	var appErr *models.AppError
	if !errors.As(err, &appErr) || appErr.Code != models.CodeInvalidArgument {
		t.Fatalf("persistent source was not protected from CloseResult: %#v", err)
	}
}

func TestRunReturnsUsefulDuckDBDiagnostic(t *testing.T) {
	db, _, projectID, people, _ := queryFixture(t)
	defer db.Close()

	_, err := New(db).Run(context.Background(), projectID, `SELECT missing_total FROM `+database.QuoteQualified(people.Schema, people.SQLName))
	var appErr *models.AppError
	if !errors.As(err, &appErr) || appErr.Code != models.CodeInvalidQuery {
		t.Fatalf("error = %#v", err)
	}
	if appErr.Message == "Query could not be executed" || !strings.Contains(appErr.Message, "missing_total") {
		t.Fatalf("diagnostic = %q", appErr.Message)
	}
	if strings.Contains(appErr.Message, "SELECT missing_total") {
		t.Fatalf("SQL excerpt was exposed: %q", appErr.Message)
	}
}

func TestStartupRemovesEphemeralResultsOnly(t *testing.T) {
	db, paths, projectID, people, _ := queryFixture(t)
	service := New(db)
	result, err := service.Run(context.Background(), projectID, `SELECT 42 AS answer`)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := database.Open(context.Background(), paths)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	state, err := workspace.New(reopened).Bootstrap(context.Background(), projectID)
	if err != nil {
		t.Fatal(err)
	}
	if len(state.Results) != 0 {
		t.Fatalf("ephemeral metadata survived reopen: %#v", state.Results)
	}
	if len(state.Datasets) != 2 {
		t.Fatalf("persistent datasets were lost: %#v", state.Datasets)
	}
	if _, err := workspace.New(reopened).GetSource(context.Background(), projectID, people.ID); err != nil {
		t.Fatalf("persistent source unavailable after reopen: %v", err)
	}
	exists, err := database.TableExists(context.Background(), reopened.SQL(), "result", result.Source.SQLName)
	if err != nil {
		t.Fatal(err)
	}
	if exists {
		t.Fatal("ephemeral result table survived reopen")
	}
}

func TestSaveAndCloseRejectResultFromAnotherProject(t *testing.T) {
	db, _, projectA, _, _ := queryFixture(t)
	defer db.Close()
	ctx := context.Background()
	ws := workspace.New(db)
	projectB, err := ws.CreateProject(ctx, "Project B", "")
	if err != nil {
		t.Fatal(err)
	}
	service := New(db)
	result, err := service.Run(ctx, projectA, `SELECT 7 AS value`)
	if err != nil {
		t.Fatal(err)
	}
	if result.Source.ProjectID != projectA {
		t.Fatalf("query result project = %q, want %q", result.Source.ProjectID, projectA)
	}

	_, err = service.SaveResult(ctx, SaveResultRequest{
		ProjectID: projectB.ID, ResultID: result.Source.ID, DisplayName: "Stolen result",
	})
	var appErr *models.AppError
	if !errors.As(err, &appErr) || appErr.Code != models.CodeSourceNotFound {
		t.Fatalf("cross-project save error = %#v, want %s", err, models.CodeSourceNotFound)
	}
	err = service.CloseResult(ctx, projectB.ID, result.Source.ID)
	if !errors.As(err, &appErr) || appErr.Code != models.CodeSourceNotFound {
		t.Fatalf("cross-project close error = %#v, want %s", err, models.CodeSourceNotFound)
	}
	if _, err := ws.GetSource(ctx, projectA, result.Source.ID); err != nil {
		t.Fatalf("cross-project operations changed project A result: %v", err)
	}
	if err := service.CloseResult(ctx, projectA, result.Source.ID); err != nil {
		t.Fatalf("project A could not close its result: %v", err)
	}
}
