package main

import (
	"errors"
	"path/filepath"
	"testing"

	"ducs-table/internal/models"
)

func TestWorkspaceOpenErrorExplainsProcessLock(t *testing.T) {
	err := workspaceOpenError(errors.New("could not set lock on file: conflicting lock is held by another process"))
	appErr := models.AsAppError(err)
	if appErr.Code != models.CodeConflict || appErr.Message == "" {
		t.Fatalf("lock error = %#v", appErr)
	}
}

func TestWorkspaceOpenErrorPreservesOtherFailures(t *testing.T) {
	original := errors.New("disk is unavailable")
	if got := workspaceOpenError(original); got != original {
		t.Fatalf("non-lock error changed: %v", got)
	}
}

func TestDroppedFilePathsRejectsInternalHTMLDrags(t *testing.T) {
	first := filepath.Join(t.TempDir(), "orders.csv")
	second := filepath.Join(t.TempDir(), "customers.csv")
	got := droppedFilePaths([]string{"", "   ", "tab-orders", first, first, second})
	want := []string{first, second}
	if len(got) != len(want) {
		t.Fatalf("dropped paths = %#v, want %#v", got, want)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("dropped paths = %#v, want %#v", got, want)
		}
	}
}
