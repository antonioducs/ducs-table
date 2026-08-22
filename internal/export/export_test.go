package exports

import (
	"context"
	"encoding/csv"
	"os"
	"path/filepath"
	"testing"

	"ducs-table/internal/apppaths"
	"ducs-table/internal/database"
	"ducs-table/internal/grid"
	"ducs-table/internal/importers"
	"ducs-table/internal/query"
)

func exportFixture(t *testing.T) (*Service, *query.Service, string) {
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
	source, err := importers.New(db).Materialize(context.Background(), importers.MaterializeRequest{
		Path: filepath.Join("..", "..", "testdata", "people.csv"),
	})
	if err != nil {
		t.Fatal(err)
	}
	return New(db), query.New(db), source.ID
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
	service, _, sourceID := exportFixture(t)
	ctx := context.Background()
	entirePath := filepath.Join(t.TempDir(), "people's entire.csv")
	result, err := service.ExportCSV(ctx, CSVRequest{SourceID: sourceID, Destination: entirePath, Scope: ScopeEntire})
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
		SourceID: sourceID, Destination: viewPath, Scope: ScopeCurrentView,
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
	service, queryService, _ := exportFixture(t)
	ctx := context.Background()
	queryResult, err := queryService.Run(ctx, `SELECT 'x' AS letter UNION ALL SELECT 'y'`)
	if err != nil {
		t.Fatal(err)
	}
	destination := filepath.Join(t.TempDir(), "result.csv")
	if _, err := service.ExportCSV(ctx, CSVRequest{SourceID: queryResult.Source.ID, Destination: destination}); err != nil {
		t.Fatal(err)
	}
	rows := readCSV(t, destination)
	if len(rows) != 3 || rows[0][0] != "letter" {
		t.Fatalf("unexpected result export: %#v", rows)
	}
	if _, err := service.ExportCSV(ctx, CSVRequest{SourceID: queryResult.Source.ID}); err == nil {
		t.Fatal("empty destination unexpectedly succeeded")
	}
}
