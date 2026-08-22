package grid

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"ducs-table/internal/apppaths"
	"ducs-table/internal/database"
	"ducs-table/internal/importers"
	"ducs-table/internal/models"
	"ducs-table/internal/workspace"
)

func gridFixture(t *testing.T) (*Service, models.SourceInfo, string) {
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
	return New(db), source, project.ID
}

func TestSyntheticLargeDatasetBlock(t *testing.T) {
	service, _, projectID := gridFixture(t)
	ctx := context.Background()
	id, err := models.NewID()
	if err != nil {
		t.Fatal(err)
	}
	err = service.db.WithTx(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `CREATE TABLE data.synthetic_large AS SELECT i AS id, 'row-' || i::VARCHAR AS label FROM range(100000) t(i)`); err != nil {
			return err
		}
		now := time.Now().UTC()
		return workspace.InsertSourceTx(ctx, tx, projectID, models.SourceInfo{
			ProjectID: projectID,
			ID:        id, DisplayName: "synthetic_large", SQLName: "synthetic_large", Schema: "data",
			SourceType: "synthetic", RowCount: 100000, CreatedAt: now, UpdatedAt: now,
		})
	})
	if err != nil {
		t.Fatal(err)
	}
	page, err := service.GetRows(ctx, RowsRequest{ProjectID: projectID, SourceID: id, Offset: 50000, Limit: 250})
	if err != nil {
		t.Fatal(err)
	}
	if page.TotalRows == nil || *page.TotalRows != 100000 || len(page.Rows) != 250 || page.Rows[0]["id"] != int64(50000) {
		t.Fatalf("unexpected synthetic block: total=%v rows=%d first=%v", page.TotalRows, len(page.Rows), page.Rows[0]["id"])
	}
}

func TestRowsPaginationSortAndProjection(t *testing.T) {
	service, source, projectID := gridFixture(t)
	ctx := context.Background()
	response, err := service.Rows(ctx, RowsRequest{
		ProjectID: projectID, SourceID: source.ID, Limit: 2,
		Sorts:          []Sort{{Column: "age", Direction: "desc"}},
		VisibleColumns: []string{"name", "age"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if response.TotalRows == nil || *response.TotalRows != 4 || len(response.Rows) != 2 {
		t.Fatalf("unexpected page metadata: %#v", response)
	}
	if response.Rows[0]["name"] != "Carla" || response.Rows[1]["name"] != "Alice" {
		t.Fatalf("unexpected sort order: %#v", response.Rows)
	}
	if _, visible := response.Rows[0]["id"]; visible {
		t.Fatal("unrequested column leaked into projection")
	}
	if len(response.Columns) != 2 || response.Columns[0].Name != "name" || response.Columns[1].Name != "age" {
		t.Fatalf("visible column order changed: %#v", response.Columns)
	}

	first, err := service.Rows(ctx, RowsRequest{ProjectID: projectID, SourceID: source.ID, Limit: 2})
	if err != nil {
		t.Fatal(err)
	}
	second, err := service.Rows(ctx, RowsRequest{ProjectID: projectID, SourceID: source.ID, Offset: 2, Limit: 2})
	if err != nil {
		t.Fatal(err)
	}
	if first.Rows[0]["id"] != int64(1) || second.Rows[0]["id"] != int64(3) {
		t.Fatalf("rowid pagination is unstable: first=%#v second=%#v", first.Rows, second.Rows)
	}
}

func TestTypedFilters(t *testing.T) {
	service, source, projectID := gridFixture(t)
	ctx := context.Background()
	tests := []struct {
		name   string
		filter Filter
		want   int64
	}{
		{"text contains", Filter{Column: "name", Type: "text", Operator: "contains", Value: "lic"}, 1},
		{"text not contains", Filter{Column: "name", Type: "text", Operator: "not contains", Value: "a"}, 2},
		{"text starts", Filter{Column: "name", Type: "text", Operator: "starts with", Value: "c"}, 1},
		{"text ends", Filter{Column: "name", Type: "text", Operator: "ends with", Value: "o"}, 1},
		{"text blank", Filter{Column: "city", Type: "text", Operator: "blank"}, 1},
		{"number equals", Filter{Column: "age", Type: "number", Operator: "equals", Value: 34}, 1},
		{"number greater", Filter{Column: "age", Type: "number", Operator: ">", Value: 30}, 2},
		{"number gte", Filter{Column: "age", Type: "number", Operator: ">=", Value: 34}, 2},
		{"number less", Filter{Column: "age", Type: "number", Operator: "<", Value: 34}, 1},
		{"number range", Filter{Column: "age", Type: "number", Operator: "range", Value: 28, ValueTo: 34}, 2},
		{"number blank", Filter{Column: "age", Type: "number", Operator: "blank"}, 1},
		{"date gte", Filter{Column: "joined_at", Type: "date", Operator: ">=", Value: "2024-01-01"}, 2},
		{"boolean true", Filter{Column: "active", Type: "boolean", Operator: "true"}, 3},
		{"boolean false", Filter{Column: "active", Type: "boolean", Operator: "false"}, 1},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := service.CountRows(ctx, projectID, source.ID, []Filter{test.filter})
			if err != nil {
				t.Fatal(err)
			}
			if got != test.want {
				t.Fatalf("count = %d, want %d", got, test.want)
			}
		})
	}
}

func TestBadColumnAndFilterTypeAreRejected(t *testing.T) {
	service, source, projectID := gridFixture(t)
	_, err := service.Rows(context.Background(), RowsRequest{
		ProjectID: projectID, SourceID: source.ID, Limit: 10,
		Sorts: []Sort{{Column: `age; DROP TABLE data.people`, Direction: "asc"}},
	})
	var appErr *models.AppError
	if !errors.As(err, &appErr) || appErr.Code != models.CodeColumnNotFound {
		t.Fatalf("bad column error = %#v", err)
	}
	_, err = service.CountRows(context.Background(), projectID, source.ID, []Filter{{Column: "name", Type: "number", Operator: ">", Value: 1}})
	if !errors.As(err, &appErr) || appErr.Code != models.CodeInvalidArgument {
		t.Fatalf("bad filter type error = %#v", err)
	}
}

func TestRowsRejectSourceFromAnotherProject(t *testing.T) {
	service, source, projectA := gridFixture(t)
	ctx := context.Background()
	projectB, err := workspace.New(service.db).CreateProject(ctx, "Project B", "")
	if err != nil {
		t.Fatal(err)
	}
	_, err = service.Rows(ctx, RowsRequest{ProjectID: projectB.ID, SourceID: source.ID, Limit: 10})
	var appErr *models.AppError
	if !errors.As(err, &appErr) || appErr.Code != models.CodeSourceNotFound {
		t.Fatalf("cross-project grid error = %#v, want %s", err, models.CodeSourceNotFound)
	}
	page, err := service.Rows(ctx, RowsRequest{ProjectID: projectA, SourceID: source.ID, Limit: 10})
	if err != nil {
		t.Fatalf("project A source became unavailable: %v", err)
	}
	if len(page.Rows) != 4 {
		t.Fatalf("project A rows = %d, want 4", len(page.Rows))
	}
}
