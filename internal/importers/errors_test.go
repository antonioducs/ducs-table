package importers

import (
	"errors"
	"testing"

	"ducs-table/internal/models"
)

func TestImportFailureClassifiesStagesWithSafeDetails(t *testing.T) {
	tests := []struct {
		stage   string
		code    string
		message string
	}{
		{stagePreview, models.CodeImportPreviewFailed, "preview"},
		{stageRead, models.CodeImportReadFailed, "parsed"},
		{stageMaterialization, models.CodeImportMaterializationFailed, "materialized"},
		{stageCount, models.CodeImportCountFailed, "verified"},
		{stagePublish, models.CodeImportPublishFailed, "published"},
		{stageCommit, models.CodeImportCommitFailed, "committed"},
	}
	for _, test := range tests {
		t.Run(test.stage, func(t *testing.T) {
			err := importFailure(FileCSV, test.stage, errors.New("driver detail that stays local"))
			var appErr *models.AppError
			if !errors.As(err, &appErr) {
				t.Fatalf("error = %#v, want AppError", err)
			}
			if appErr.Code != test.code || appErr.Details["stage"] != test.stage || appErr.Details["sourceType"] != "csv" {
				t.Fatalf("unexpected classified error: %#v", appErr)
			}
			if appErr.Details["suggestion"] == "" || appErr.Message == "" {
				t.Fatalf("missing safe presentation: %#v", appErr)
			}
			if appErr.Cause == nil {
				t.Fatal("technical cause was not retained for local logging")
			}
		})
	}
}

func TestValidationFailurePreservesStableCode(t *testing.T) {
	original := models.NewError(models.CodeUnsupportedFile, "Unsupported file type", nil)
	err := importFailure("", stageValidation, original)
	var appErr *models.AppError
	if !errors.As(err, &appErr) {
		t.Fatal(err)
	}
	if appErr.Code != models.CodeUnsupportedFile || appErr.Details["stage"] != stageValidation {
		t.Fatalf("validation error = %#v", appErr)
	}
}

func TestSourceReadStageDistinguishesParserAndStorageFailures(t *testing.T) {
	if got := sourceReadStage(FileCSV, errors.New("CSV Error: expected number of columns"), stagePreview); got != stageRead {
		t.Fatalf("parser stage = %q", got)
	}
	if got := sourceReadStage(FileCSV, errors.New("IO Error: file disappeared"), stagePreview); got != stagePreview {
		t.Fatalf("preview fallback stage = %q", got)
	}
	if got := sourceReadStage(FileCSV, errors.New("IO Error: could not allocate block"), stageMaterialization); got != stageMaterialization {
		t.Fatalf("materialization fallback stage = %q", got)
	}
}
