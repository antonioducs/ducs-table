package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"ducs-table/internal/applog"
	"ducs-table/internal/models"
)

func TestRecordImportFailureCorrelatesSafeFeedbackWithSanitizedLog(t *testing.T) {
	logPath := filepath.Join(t.TempDir(), "app.log")
	logger, err := applog.Open(logPath, applog.Options{MaxBytes: 4096, Backups: 1})
	if err != nil {
		t.Fatal(err)
	}
	app := &App{logger: logger}
	sourcePath := filepath.Join(t.TempDir(), "customers.csv")
	cause := errors.New("CSV Error\nOriginal Line: alice,private-row\nfile=" + sourcePath + " password=do-not-log")
	classified := models.WrapError(models.CodeImportReadFailed, "The CSV source could not be parsed", cause, map[string]any{
		"stage": "read", "sourceType": "csv", "suggestion": "Check the delimiter",
	})
	diagnostic := importDiagnostic{ProjectID: "project-1", SourceID: "source-1", Path: sourcePath, SourceType: "csv", Size: 123, StartedAt: time.Now()}
	visible := app.recordImportFailure(classified, diagnostic)
	if visible.Details["errorRef"] == "" || visible.Details["logPath"] != logPath || visible.Details["stage"] != "read" {
		t.Fatalf("visible error = %#v", visible)
	}
	if err := logger.Close(); err != nil {
		t.Fatal(err)
	}
	contents, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	text := string(contents)
	for _, secret := range []string{"alice,private-row", sourcePath, "do-not-log"} {
		if strings.Contains(text, secret) {
			t.Fatalf("log leaked %q: %s", secret, text)
		}
	}
	if !strings.Contains(text, visible.Details["errorRef"].(string)) || !strings.Contains(text, `"stage":"read"`) {
		t.Fatalf("correlation fields missing from log: %s", text)
	}
}
