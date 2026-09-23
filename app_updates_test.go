package main

import (
	"encoding/json"
	"errors"
	"os"
	"testing"

	"ducs-table/internal/models"
	"ducs-table/internal/update"
)

func TestAppVersionIsTheReleasedManifestVersion(t *testing.T) {
	version := appVersion()
	if _, err := update.ParseVersion(version); err != nil {
		t.Fatalf("embedded version %q is not SemVer: %v", version, err)
	}
	data, err := os.ReadFile("package.json")
	if err != nil {
		t.Fatal(err)
	}
	var manifest struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal(data, &manifest); err != nil {
		t.Fatal(err)
	}
	if manifest.Version != version {
		t.Fatalf("wails.json version %q differs from package.json %q", version, manifest.Version)
	}
}

func TestUpdateBindingsWithoutAServiceAreInert(t *testing.T) {
	app := NewApp()
	if state := app.UpdateCheck(); state.Mode != update.ModeOff || state.CurrentVersion != appVersion() {
		t.Fatalf("state without update service = %+v", state)
	}
	if _, err := app.UpdateInstall(); models.AsAppError(err).Code != models.CodeConflict {
		t.Fatalf("install without service = %v", err)
	}
}

func TestUpdateErrorIsASentenceForTheUI(t *testing.T) {
	cause := errors.New("no update is available to download.")
	err := updateError(cause)
	if appErr := models.AsAppError(err); appErr.Message != "No update is available to download" || !errors.Is(err, cause) {
		t.Fatalf("update error = %#v", appErr)
	}
	if updateError(nil) != nil {
		t.Fatal("nil must stay nil")
	}
}
