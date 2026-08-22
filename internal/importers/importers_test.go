package importers

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"ducs-table/internal/apppaths"
	"ducs-table/internal/database"
	"ducs-table/internal/models"
	"ducs-table/internal/workspace"

	"github.com/xuri/excelize/v2"
)

func openImporterTestDB(t *testing.T) (*database.DB, apppaths.Paths, string) {
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
	return db, paths, project.ID
}

func fixture(name string) string { return filepath.Join("..", "..", "testdata", name) }

func TestPreviewAndMaterializeSupportedTextFormats(t *testing.T) {
	db, _, projectID := openImporterTestDB(t)
	service := New(db)
	ctx := context.Background()
	tests := []struct {
		file      string
		wantRows  int
		wantFirst string
	}{
		{"people.csv", 4, "id"},
		{"orders.tsv", 3, "order_id"},
		{"records.json", 3, "id"},
		{"events.ndjson", 3, "event_id"},
		{"events.jsonl", 2, "event_id"},
	}
	for _, test := range tests {
		t.Run(test.file, func(t *testing.T) {
			preview, err := service.Preview(ctx, fixture(test.file), Options{}, "", 200)
			if err != nil {
				t.Fatal(err)
			}
			if len(preview.Rows) != test.wantRows {
				t.Fatalf("preview rows = %d, want %d", len(preview.Rows), test.wantRows)
			}
			if len(preview.Columns) == 0 || preview.Columns[0].Name != test.wantFirst {
				t.Fatalf("unexpected columns: %#v", preview.Columns)
			}
			source, err := service.Materialize(ctx, MaterializeRequest{ProjectID: projectID, Path: fixture(test.file)})
			if err != nil {
				t.Fatal(err)
			}
			if source.ProjectID != projectID || source.RowCount != int64(test.wantRows) || source.Schema != "data" || len(source.Columns) == 0 {
				t.Fatalf("unexpected source: %#v", source)
			}
		})
	}
	state, err := workspace.New(db).Bootstrap(ctx, projectID)
	if err != nil {
		t.Fatal(err)
	}
	if len(state.Datasets) != len(tests) {
		t.Fatalf("datasets = %d, want %d", len(state.Datasets), len(tests))
	}
}

func TestValidationErrorsAndStagingCleanup(t *testing.T) {
	db, _, projectID := openImporterTestDB(t)
	service := New(db)
	for path, code := range map[string]string{
		"legacy.xls":     models.CodeXLSUnsupported,
		"source.parquet": models.CodeUnsupportedFile,
	} {
		_, err := service.Validate(path)
		var appErr *models.AppError
		if !errors.As(err, &appErr) || appErr.Code != code {
			t.Fatalf("Validate(%q) error = %#v, want code %s", path, err, code)
		}
	}
	broken := filepath.Join(t.TempDir(), "broken.json")
	if err := os.WriteFile(broken, []byte(`[{"not": "closed"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Materialize(context.Background(), MaterializeRequest{ProjectID: projectID, Path: broken}); err == nil {
		t.Fatal("broken JSON unexpectedly imported")
	}
	var staging int
	if err := db.SQL().QueryRow(`SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'data' AND table_name LIKE '__staging_%'`).Scan(&staging); err != nil {
		t.Fatal(err)
	}
	if staging != 0 {
		t.Fatalf("found %d orphan staging tables", staging)
	}
	var metadata int
	if err := db.SQL().QueryRow(`SELECT COUNT(*) FROM ducs_meta.datasets`).Scan(&metadata); err != nil {
		t.Fatal(err)
	}
	if metadata != 0 {
		t.Fatalf("found %d metadata rows after failed import", metadata)
	}
}

func TestWorkbookSheetListingAndConditionalImport(t *testing.T) {
	workbookPath := filepath.Join(t.TempDir(), "book.xlsx")
	workbook := excelize.NewFile()
	if err := workbook.SetCellValue("Sheet1", "A1", "id"); err != nil {
		t.Fatal(err)
	}
	if err := workbook.SetCellValue("Sheet1", "B1", "name"); err != nil {
		t.Fatal(err)
	}
	if err := workbook.SetCellValue("Sheet1", "A2", 1); err != nil {
		t.Fatal(err)
	}
	if err := workbook.SetCellValue("Sheet1", "B2", "alpha"); err != nil {
		t.Fatal(err)
	}
	second, err := workbook.NewSheet("Second Sheet")
	if err != nil {
		t.Fatal(err)
	}
	workbook.SetActiveSheet(second)
	if err := workbook.SetCellValue("Second Sheet", "A1", "value"); err != nil {
		t.Fatal(err)
	}
	if err := workbook.SetCellValue("Second Sheet", "A2", 42); err != nil {
		t.Fatal(err)
	}
	if err := workbook.SaveAs(workbookPath); err != nil {
		t.Fatal(err)
	}
	if err := workbook.Close(); err != nil {
		t.Fatal(err)
	}
	sheets, err := ListSheets(workbookPath)
	if err != nil {
		t.Fatal(err)
	}
	if len(sheets) != 2 || sheets[0] != "Sheet1" || sheets[1] != "Second Sheet" {
		t.Fatalf("unexpected sheets: %#v", sheets)
	}

	db, _, projectID := openImporterTestDB(t)
	service := New(db)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	preview, err := service.Preview(ctx, workbookPath, Options{}, "Second Sheet", 10)
	if err != nil {
		var appErr *models.AppError
		if errors.As(err, &appErr) && appErr.Code == models.CodeXLSXExtensionUnavailable {
			t.Skipf("DuckDB Excel extension unavailable in test environment: %v", err)
		}
		t.Fatal(err)
	}
	if preview.Sheet != "Second Sheet" || len(preview.Rows) != 1 {
		t.Fatalf("unexpected workbook preview: %#v", preview)
	}
	source, err := service.Materialize(ctx, MaterializeRequest{ProjectID: projectID, Path: workbookPath, Sheet: "Sheet1"})
	if err != nil {
		t.Fatal(err)
	}
	if source.RowCount != 1 || source.Sheet != "Sheet1" {
		t.Fatalf("unexpected workbook source: %#v", source)
	}
}

func TestMetadataPersistsAcrossReopen(t *testing.T) {
	root := filepath.Join(t.TempDir(), "state")
	paths, err := apppaths.ResolveAt(root)
	if err != nil {
		t.Fatal(err)
	}
	db, err := database.Open(context.Background(), paths)
	if err != nil {
		t.Fatal(err)
	}
	project, err := workspace.New(db).InitialProject(context.Background())
	if err != nil {
		_ = db.Close()
		t.Fatal(err)
	}
	if project.Name != "My Workspace" {
		_ = db.Close()
		t.Fatalf("initial project = %q, want My Workspace", project.Name)
	}
	service := New(db)
	source, err := service.Materialize(context.Background(), MaterializeRequest{ProjectID: project.ID, Path: fixture("people.csv")})
	if err != nil {
		t.Fatal(err)
	}
	savedQuery, err := workspace.New(db).CreateSavedQuery(context.Background(), project.ID, "Adults", `SELECT * FROM data.people WHERE age >= 18`)
	if err != nil {
		t.Fatal(err)
	}
	if source.ProjectID != project.ID || savedQuery.ProjectID != project.ID {
		t.Fatalf("project ownership was not persisted: source=%q query=%q", source.ProjectID, savedQuery.ProjectID)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := database.Open(context.Background(), paths)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	state, err := workspace.New(reopened).Bootstrap(context.Background(), project.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(state.Datasets) != 1 || state.Datasets[0].ID != source.ID || state.Datasets[0].RowCount != 4 {
		t.Fatalf("dataset metadata did not persist: %#v", state.Datasets)
	}
	if len(state.SavedQueries) != 1 || state.SavedQueries[0].Name != "Adults" {
		t.Fatalf("saved query did not persist: %#v", state.SavedQueries)
	}
}

func TestImportsAreProjectOwnedWithGloballyUniquePhysicalNames(t *testing.T) {
	db, _, projectA := openImporterTestDB(t)
	ctx := context.Background()
	ws := workspace.New(db)
	projectB, err := ws.CreateProject(ctx, "Project B", "")
	if err != nil {
		t.Fatal(err)
	}
	service := New(db)
	sourceA, err := service.Materialize(ctx, MaterializeRequest{
		ProjectID: projectA, Path: fixture("people.csv"), DisplayName: "Shared people",
	})
	if err != nil {
		t.Fatal(err)
	}
	sourceB, err := service.Materialize(ctx, MaterializeRequest{
		ProjectID: projectB.ID, Path: fixture("people.csv"), DisplayName: "Shared people",
	})
	if err != nil {
		t.Fatal(err)
	}
	if sourceA.ProjectID != projectA || sourceB.ProjectID != projectB.ID {
		t.Fatalf("unexpected project ownership: A=%q B=%q", sourceA.ProjectID, sourceB.ProjectID)
	}
	if sourceA.DisplayName != sourceB.DisplayName || sourceA.SQLName == sourceB.SQLName {
		t.Fatalf("same display name did not receive distinct physical names: A=%+v B=%+v", sourceA, sourceB)
	}

	err = ws.RemoveDataset(ctx, projectB.ID, sourceA.ID)
	var appErr *models.AppError
	if !errors.As(err, &appErr) || appErr.Code != models.CodeSourceNotFound {
		t.Fatalf("cross-project remove error = %#v, want %s", err, models.CodeSourceNotFound)
	}
	if _, err := ws.GetSource(ctx, projectA, sourceA.ID); err != nil {
		t.Fatalf("cross-project remove changed project A source: %v", err)
	}
	exists, err := database.TableExists(ctx, db.SQL(), sourceA.Schema, sourceA.SQLName)
	if err != nil {
		t.Fatal(err)
	}
	if !exists {
		t.Fatal("cross-project remove dropped project A physical table")
	}
}
