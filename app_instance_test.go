package main

import (
	"errors"
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
