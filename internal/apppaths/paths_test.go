package apppaths

import (
	"os"
	"path/filepath"
	"testing"
)

func TestResolveAtCreatesPrivateLayout(t *testing.T) {
	base := filepath.Join(t.TempDir(), "Application Support", "Duc's Table test")
	paths, err := ResolveAt(base)
	if err != nil {
		t.Fatal(err)
	}
	if paths.BaseDir != base {
		t.Fatalf("BaseDir = %q, want %q", paths.BaseDir, base)
	}
	if paths.DBPath != filepath.Join(base, databaseFilename) {
		t.Fatalf("unexpected DB path: %q", paths.DBPath)
	}
	for _, directory := range []string{paths.BaseDir, paths.TempDir, paths.ExtensionsDir} {
		info, err := os.Stat(directory)
		if err != nil {
			t.Fatalf("stat %s: %v", directory, err)
		}
		if !info.IsDir() {
			t.Fatalf("%s is not a directory", directory)
		}
	}
	logInfo, err := os.Stat(paths.LogPath)
	if err != nil {
		t.Fatal(err)
	}
	if !logInfo.Mode().IsRegular() {
		t.Fatalf("%s is not a regular log file", paths.LogPath)
	}
}

func TestResolveRejectsMultipleBases(t *testing.T) {
	if _, err := Resolve("one", "two"); err == nil {
		t.Fatal("expected an error")
	}
}
