package exports

import (
	"context"
	"encoding/csv"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"ducs-table/internal/apppaths"
	"ducs-table/internal/database"
	"ducs-table/internal/grid"
	"ducs-table/internal/importers"
	"ducs-table/internal/models"
	"ducs-table/internal/query"
	"ducs-table/internal/workspace"
)

func exportFixture(t *testing.T) (*Service, *query.Service, string, string) {
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
	t.Cleanup(func() { _ = db.Close() })
	project, err := workspace.New(db).InitialProject(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if project.Name != "My Workspace" {
		t.Fatalf("initial project = %q, want My Workspace", project.Name)
	}
	source, err := importers.New(db).Materialize(ctx, importers.MaterializeRequest{
		ProjectID: project.ID, Path: filepath.Join("..", "..", "testdata", "people.csv"),
	})
	if err != nil {
		t.Fatal(err)
	}
	return New(db), query.New(db), project.ID, source.ID
}

func readCSV(t *testing.T, path string) [][]string {
	t.Helper()
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	records, err := csv.NewReader(file).ReadAll()
	if err != nil {
		t.Fatal(err)
	}
	return records
}

func TestExportEntireAndCurrentView(t *testing.T) {
	service, _, projectID, sourceID := exportFixture(t)
	ctx := context.Background()
	entirePath := filepath.Join(t.TempDir(), "people's entire.csv")
	result, err := service.ExportCSV(ctx, CSVRequest{ProjectID: projectID, SourceID: sourceID, Destination: entirePath, Scope: ScopeEntire})
	if err != nil {
		t.Fatal(err)
	}
	if result.Path != entirePath || result.Size <= 0 {
		t.Fatalf("unexpected export result: %#v", result)
	}
	rows := readCSV(t, entirePath)
	if len(rows) != 5 || rows[0][0] != "id" || rows[1][1] != "Alice" {
		t.Fatalf("unexpected entire CSV: %#v", rows)
	}

	viewPath := filepath.Join(t.TempDir(), "active.csv")
	result, err = service.ExportCSV(ctx, CSVRequest{
		ProjectID: projectID, SourceID: sourceID, Destination: viewPath, Scope: ScopeCurrentView,
		VisibleColumns: []string{"name", "age"},
		Filters:        []grid.Filter{{Column: "active", Type: "boolean", Operator: "true"}},
		Sorts:          []grid.Sort{{Column: "age", Direction: "desc"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	rows = readCSV(t, viewPath)
	if len(rows) != 4 || rows[0][0] != "name" || rows[0][1] != "age" {
		t.Fatalf("unexpected current-view CSV: %#v", rows)
	}
	if rows[1][0] != "Carla" || rows[2][0] != "Alice" || rows[3][0] != "Diego" {
		t.Fatalf("view sort/filter was not preserved: %#v", rows)
	}
}

func TestExportQueryResultAndDestinationValidation(t *testing.T) {
	service, queryService, projectID, _ := exportFixture(t)
	ctx := context.Background()
	queryResult, err := queryService.Run(ctx, projectID, `SELECT 'x' AS letter UNION ALL SELECT 'y'`)
	if err != nil {
		t.Fatal(err)
	}
	destination := filepath.Join(t.TempDir(), "result.csv")
	if _, err := service.ExportCSV(ctx, CSVRequest{ProjectID: projectID, SourceID: queryResult.Source.ID, Destination: destination}); err != nil {
		t.Fatal(err)
	}
	rows := readCSV(t, destination)
	if len(rows) != 3 || rows[0][0] != "letter" {
		t.Fatalf("unexpected result export: %#v", rows)
	}
	if _, err := service.ExportCSV(ctx, CSVRequest{ProjectID: projectID, SourceID: queryResult.Source.ID}); err == nil {
		t.Fatal("empty destination unexpectedly succeeded")
	}
}

func TestExportRejectsSourceFromAnotherProject(t *testing.T) {
	service, _, projectA, sourceID := exportFixture(t)
	ctx := context.Background()
	projectB, err := workspace.New(service.db).CreateProject(ctx, "Project B", "")
	if err != nil {
		t.Fatal(err)
	}
	destination := filepath.Join(t.TempDir(), "cross-project.csv")
	_, err = service.ExportCSV(ctx, CSVRequest{ProjectID: projectB.ID, SourceID: sourceID, Destination: destination})
	var appErr *models.AppError
	if !errors.As(err, &appErr) || appErr.Code != models.CodeSourceNotFound {
		t.Fatalf("cross-project export error = %#v, want %s", err, models.CodeSourceNotFound)
	}
	if _, err := os.Stat(destination); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("cross-project export created destination: %v", err)
	}
	if _, err := service.ExportCSV(ctx, CSVRequest{ProjectID: projectA, SourceID: sourceID, Destination: destination}); err != nil {
		t.Fatalf("project A export failed: %v", err)
	}
}
