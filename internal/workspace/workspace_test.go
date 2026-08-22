package workspace_test

import (
	"context"
	"errors"
	"path/filepath"
	"testing"

	"ducs-table/internal/apppaths"
	"ducs-table/internal/database"
	"ducs-table/internal/importers"
	"ducs-table/internal/models"
	"ducs-table/internal/workspace"
)

func TestDatasetAndSavedQueryCRUD(t *testing.T) {
	paths, err := apppaths.ResolveAt(filepath.Join(t.TempDir(), "state"))
	if err != nil {
		t.Fatal(err)
	}
	db, err := database.Open(context.Background(), paths)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx := context.Background()
	source, err := importers.New(db).Materialize(ctx, importers.MaterializeRequest{Path: filepath.Join("..", "..", "testdata", "people.csv")})
	if err != nil {
		t.Fatal(err)
	}
	service := workspace.New(db)
	got, err := service.GetDataset(ctx, source.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.RowCount != 4 || len(got.Columns) == 0 {
		t.Fatalf("unexpected dataset: %#v", got)
	}

	saved, err := service.CreateSavedQuery(ctx, "Adults", `SELECT * FROM data.people WHERE age >= 18`)
	if err != nil {
		t.Fatal(err)
	}
	updated, err := service.UpdateSavedQuery(ctx, saved.ID, "Adults 21+", `SELECT * FROM data.people WHERE age >= 21`)
	if err != nil {
		t.Fatal(err)
	}
	if updated.Name != "Adults 21+" || updated.SQL == saved.SQL {
		t.Fatalf("saved query was not updated: %#v", updated)
	}
	if _, err := service.CreateSavedQuery(ctx, "adults 21+", `SELECT 1`); err == nil {
		t.Fatal("case-insensitive duplicate name succeeded")
	}
	queries, err := service.ListSavedQueries(ctx)
	if err != nil || len(queries) != 1 {
		t.Fatalf("saved query list = %#v, err=%v", queries, err)
	}
	if err := service.DeleteSavedQuery(ctx, saved.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := service.GetSavedQuery(ctx, saved.ID); err == nil {
		t.Fatal("deleted query still exists")
	}

	if err := service.RemoveDataset(ctx, source.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := service.GetSource(ctx, source.ID); err == nil {
		t.Fatal("removed dataset metadata still exists")
	} else {
		var appErr *models.AppError
		if !errors.As(err, &appErr) || appErr.Code != models.CodeSourceNotFound {
			t.Fatalf("unexpected not-found error: %#v", err)
		}
	}
	exists, err := database.TableExists(ctx, db.SQL(), source.Schema, source.SQLName)
	if err != nil {
		t.Fatal(err)
	}
	if exists {
		t.Fatal("removed dataset table still exists")
	}
}
