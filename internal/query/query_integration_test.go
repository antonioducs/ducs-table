package query

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"testing"

	"ducs-table/internal/apppaths"
	"ducs-table/internal/database"
	"ducs-table/internal/grid"
	"ducs-table/internal/importers"
	"ducs-table/internal/models"
	"ducs-table/internal/workspace"
)

func queryFixture(t *testing.T) (*database.DB, apppaths.Paths, models.SourceInfo, models.SourceInfo) {
	t.Helper()
	paths, err := apppaths.ResolveAt(filepath.Join(t.TempDir(), "state"))
	if err != nil {
		t.Fatal(err)
	}
	db, err := database.Open(context.Background(), paths)
	if err != nil {
		t.Fatal(err)
	}
	importer := importers.New(db)
	people, err := importer.Materialize(context.Background(), importers.MaterializeRequest{Path: filepath.Join("..", "..", "testdata", "people.csv")})
	if err != nil {
		_ = db.Close()
		t.Fatal(err)
	}
	orders, err := importer.Materialize(context.Background(), importers.MaterializeRequest{Path: filepath.Join("..", "..", "testdata", "orders.tsv")})
	if err != nil {
		_ = db.Close()
		t.Fatal(err)
	}
	return db, paths, people, orders
}

func TestRunJoinSaveCopyMoveAndClose(t *testing.T) {
	db, _, people, orders := queryFixture(t)
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
	result, err := service.Run(ctx, joinSQL)
	if err != nil {
		t.Fatal(err)
	}
	if result.Source.Schema != "result" || !result.Source.IsEphemeral || result.RowCount != 2 || len(result.Columns) != 3 {
		t.Fatalf("unexpected query result: %#v", result)
	}
	page, err := grid.New(db).Rows(ctx, grid.RowsRequest{SourceID: result.Source.ID, Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Rows) != 2 || page.Rows[0]["name"] != "Alice" {
		t.Fatalf("unexpected materialized rows: %#v", page.Rows)
	}

	copied, err := service.SaveResult(ctx, SaveResultRequest{ResultID: result.Source.ID, DisplayName: "Order totals", Copy: true})
	if err != nil {
		t.Fatal(err)
	}
	if copied.Schema != "data" || copied.IsEphemeral || copied.ID == result.Source.ID {
		t.Fatalf("unexpected copied source: %#v", copied)
	}
	if _, err := workspace.New(db).GetSource(ctx, result.Source.ID); err != nil {
		t.Fatalf("copy removed original result: %v", err)
	}
	if err := service.CloseResult(ctx, result.Source.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := workspace.New(db).GetSource(ctx, copied.ID); err != nil {
		t.Fatalf("closing result removed persistent copy: %v", err)
	}

	moveResult, err := service.Run(ctx, `SELECT 1 AS id, 'semi;colon' AS label; -- trailing comment`)
	if err != nil {
		t.Fatal(err)
	}
	moved, err := service.SaveResultAsTable(ctx, moveResult.Source.ID, "Pinned result")
	if err != nil {
		t.Fatal(err)
	}
	if moved.ID != moveResult.Source.ID || moved.Schema != "data" || moved.IsEphemeral {
		t.Fatalf("unexpected moved result: %#v", moved)
	}
	err = service.CloseResult(ctx, moved.ID)
	var appErr *models.AppError
	if !errors.As(err, &appErr) || appErr.Code != models.CodeInvalidArgument {
		t.Fatalf("persistent source was not protected from CloseResult: %#v", err)
	}
}

func TestStartupRemovesEphemeralResultsOnly(t *testing.T) {
	db, paths, people, _ := queryFixture(t)
	service := New(db)
	result, err := service.Run(context.Background(), `SELECT 42 AS answer`)
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
	state, err := workspace.New(reopened).Bootstrap(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(state.Results) != 0 {
		t.Fatalf("ephemeral metadata survived reopen: %#v", state.Results)
	}
	if len(state.Datasets) != 2 {
		t.Fatalf("persistent datasets were lost: %#v", state.Datasets)
	}
	if _, err := workspace.New(reopened).GetSource(context.Background(), people.ID); err != nil {
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
