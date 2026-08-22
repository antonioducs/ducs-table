package main

import (
	"context"
	"encoding/csv"
	"os"
	"path/filepath"
	"testing"

	"ducs-table/internal/apppaths"
	"ducs-table/internal/database"
	exportservice "ducs-table/internal/export"
	"ducs-table/internal/grid"
	"ducs-table/internal/importers"
	"ducs-table/internal/query"
	"ducs-table/internal/workspace"
)

func TestWorkspaceSmokeFlow(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	paths, err := apppaths.ResolveAt(filepath.Join(t.TempDir(), "workspace"))
	if err != nil {
		t.Fatal(err)
	}
	db, err := database.Open(ctx, paths)
	if err != nil {
		t.Fatal(err)
	}

	ws := workspace.New(db)
	project, err := ws.InitialProject(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if project.Name != "My Workspace" {
		t.Fatalf("initial project = %q, want My Workspace", project.Name)
	}
	imports := importers.New(db)
	gridService := grid.New(db, ws)
	queries := query.New(db)
	exports := exportservice.New(db, gridService)

	customersPath := filepath.Join("testdata", "csv", "customers.csv")
	ordersPath := filepath.Join("testdata", "json", "orders.json")
	customers, err := imports.Materialize(ctx, importers.MaterializeRequest{ProjectID: project.ID, Path: customersPath, DisplayName: "customers"})
	if err != nil {
		t.Fatal(err)
	}
	orders, err := imports.Materialize(ctx, importers.MaterializeRequest{ProjectID: project.ID, Path: ordersPath, DisplayName: "orders"})
	if err != nil {
		t.Fatal(err)
	}
	if customers.ProjectID != project.ID || orders.ProjectID != project.ID {
		t.Fatalf("imports were not scoped to the active project: customers=%q orders=%q", customers.ProjectID, orders.ProjectID)
	}

	view, err := gridService.GetRows(ctx, grid.RowsRequest{
		ProjectID: project.ID, SourceID: customers.ID, Offset: 0, Limit: 250,
		VisibleColumns: []string{"customer_id", "name"},
		Filters:        []grid.Filter{{Column: "segment", Type: "text", Operator: "equals", Value: "enterprise"}},
		Sorts:          []grid.Sort{{Column: "name", Direction: "desc"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(view.Rows) != 2 || len(view.Columns) != 2 {
		t.Fatalf("unexpected filtered view: %d rows, %d columns", len(view.Rows), len(view.Columns))
	}

	joined, err := queries.Run(ctx, project.ID, `
		SELECT
			c.customer_id,
			c.name,
			count(*) AS order_count,
			sum(o.total) AS total_spent
		FROM customers c
		JOIN orders o ON o.customer_id = c.customer_id
		GROUP BY c.customer_id, c.name
		ORDER BY total_spent DESC`)
	if err != nil {
		t.Fatal(err)
	}
	if joined.RowCount != 3 {
		t.Fatalf("join returned %d rows", joined.RowCount)
	}
	saved, err := queries.SaveResultAsTable(ctx, project.ID, joined.Source.ID, "customer_summary")
	if err != nil {
		t.Fatal(err)
	}
	if saved.ProjectID != project.ID || saved.SQLName != "customer_summary" || saved.IsEphemeral {
		t.Fatalf("unexpected saved source: %+v", saved)
	}

	second, err := queries.Run(ctx, project.ID, `SELECT name, total_spent FROM customer_summary WHERE total_spent >= 100 ORDER BY total_spent DESC`)
	if err != nil {
		t.Fatal(err)
	}
	destination := filepath.Join(t.TempDir(), "customer_summary.csv")
	if _, err := exports.ExportCSV(ctx, exportservice.CSVRequest{
		ProjectID: project.ID, SourceID: second.Source.ID, Destination: destination, Scope: exportservice.ScopeEntire,
	}); err != nil {
		t.Fatal(err)
	}
	file, err := os.Open(destination)
	if err != nil {
		t.Fatal(err)
	}
	records, err := csv.NewReader(file).ReadAll()
	closeErr := file.Close()
	if err != nil || closeErr != nil {
		t.Fatalf("read export: %v, close: %v", err, closeErr)
	}
	if len(records) != 3 || len(records[0]) != 2 || records[0][0] != "name" || records[0][1] != "total_spent" {
		t.Fatalf("unexpected export: %#v", records)
	}

	if _, err := imports.Preview(ctx, filepath.Join("testdata", "json", "invalid.json"), importers.Options{}, "", 20); err == nil {
		t.Fatal("invalid JSON unexpectedly previewed")
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := database.Open(ctx, paths)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	state, err := workspace.New(reopened).Bootstrap(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(state.Datasets) != 3 {
		t.Fatalf("expected customers, orders and saved summary after reopen; got %d", len(state.Datasets))
	}
	if len(state.Results) != 0 {
		t.Fatalf("ephemeral results survived reopen: %d", len(state.Results))
	}
	if state.Project.ID != project.ID || state.Project.Name != "My Workspace" {
		t.Fatalf("unexpected reopened project: %+v", state.Project)
	}
}
