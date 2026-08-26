package applog

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoggerWritesSanitizedErrorAndPrivateFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "app.log")
	logger, err := Open(path, Options{MaxBytes: 4096, Backups: 1})
	if err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(t.TempDir(), "customers.csv")
	cause := errors.New("CSV Error: could not convert 'private-cell' Original Line: alice,inline-private\nOriginal Line: alice,private-value\nInvalid Input: {\"password\":\"json-secret\",\"name\":\"alice\"}\nfile=" + source + " password=hunter2 token=abc")
	reference := logger.Error("import failed", cause, []string{source}, "stage", "read")
	if reference == "" {
		t.Fatal("empty error reference")
	}
	if err := logger.Close(); err != nil {
		t.Fatal(err)
	}
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	text := string(contents)
	for _, secret := range []string{"private-cell", "alice,inline-private", "alice,private-value", "json-secret", `"name":"alice"`, source, "hunter2", "token=abc"} {
		if strings.Contains(text, secret) {
			t.Fatalf("log leaked %q: %s", secret, text)
		}
	}
	for _, expected := range []string{"CSV Error", "[SOURCE]", "[REDACTED]", reference, `"stage":"read"`} {
		if !strings.Contains(text, expected) {
			t.Fatalf("log does not contain %q: %s", expected, text)
		}
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("log permissions = %o, want 600", info.Mode().Perm())
	}
}

func TestLoggerRotatesBySize(t *testing.T) {
	path := filepath.Join(t.TempDir(), "app.log")
	logger, err := Open(path, Options{MaxBytes: 280, Backups: 2})
	if err != nil {
		t.Fatal(err)
	}
	for index := 0; index < 12; index++ {
		logger.Info("rotation-test", "index", index, "payload", strings.Repeat("x", 80))
	}
	if err := logger.Close(); err != nil {
		t.Fatal(err)
	}
	for _, candidate := range []string{path, path + ".1", path + ".2"} {
		info, err := os.Stat(candidate)
		if err != nil {
			t.Fatalf("stat %s: %v", candidate, err)
		}
		if info.Size() == 0 {
			t.Fatalf("%s is empty", candidate)
		}
	}
	if _, err := os.Stat(path + ".3"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("unexpected third backup: %v", err)
	}
}

func TestLoggerDoesNotReturnReferenceWhenEntryWasNotWritten(t *testing.T) {
	path := filepath.Join(t.TempDir(), "app.log")
	logger, err := Open(path, Options{MaxBytes: 4096, Backups: 1})
	if err != nil {
		t.Fatal(err)
	}
	if err := logger.Close(); err != nil {
		t.Fatal(err)
	}
	if reference := logger.Error("late failure", errors.New("disk unavailable"), nil); reference != "" {
		t.Fatalf("unwritten entry returned reference %q", reference)
	}
}
