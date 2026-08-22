// Package apppaths resolves and creates the directories used by Duc's Table.
package apppaths

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

const (
	applicationDirectory = "Duc's Table"
	databaseFilename     = "workspace.duckdb"
	logFilename          = "app.log"
)

// Paths contains every writable path used by the backend.
type Paths struct {
	BaseDir       string `json:"baseDir"`
	TempDir       string `json:"tempDir"`
	ExtensionsDir string `json:"extensionsDir"`
	LogPath       string `json:"logPath"`
	DBPath        string `json:"dbPath"`
}

// Resolve returns initialized application paths. With no argument it uses the
// operating system's per-user config directory (Application Support on macOS).
// An explicit base directory is useful for tests and portable installations.
func Resolve(explicitBase ...string) (Paths, error) {
	if len(explicitBase) > 1 {
		return Paths{}, errors.New("apppaths: expected at most one base directory")
	}

	var base string
	if len(explicitBase) == 1 {
		base = explicitBase[0]
	}
	if base == "" {
		configDir, err := os.UserConfigDir()
		if err != nil {
			return Paths{}, fmt.Errorf("apppaths: resolve user config directory: %w", err)
		}
		base = filepath.Join(configDir, applicationDirectory)
	}

	absBase, err := filepath.Abs(base)
	if err != nil {
		return Paths{}, fmt.Errorf("apppaths: resolve base directory: %w", err)
	}
	absBase = filepath.Clean(absBase)
	paths := Paths{
		BaseDir:       absBase,
		TempDir:       filepath.Join(absBase, "temp"),
		ExtensionsDir: filepath.Join(absBase, "extensions"),
		LogPath:       filepath.Join(absBase, logFilename),
		DBPath:        filepath.Join(absBase, databaseFilename),
	}
	if err := paths.Ensure(); err != nil {
		return Paths{}, err
	}
	return paths, nil
}

// ResolveAt is the explicit-base counterpart of Resolve.
func ResolveAt(baseDir string) (Paths, error) {
	if baseDir == "" {
		return Paths{}, errors.New("apppaths: explicit base directory is empty")
	}
	return Resolve(baseDir)
}

// Default resolves the normal per-user application paths.
func Default() (Paths, error) { return Resolve() }

// Ensure creates the application directories with private permissions.
func (p Paths) Ensure() error {
	for _, dir := range []string{p.BaseDir, p.TempDir, p.ExtensionsDir} {
		if dir == "" {
			return errors.New("apppaths: an application directory is empty")
		}
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return fmt.Errorf("apppaths: create %q: %w", dir, err)
		}
		info, err := os.Stat(dir)
		if err != nil {
			return fmt.Errorf("apppaths: stat %q: %w", dir, err)
		}
		if !info.IsDir() {
			return fmt.Errorf("apppaths: %q is not a directory", dir)
		}
	}
	if p.DBPath == "" {
		return errors.New("apppaths: database path is empty")
	}
	if p.LogPath == "" {
		return errors.New("apppaths: log path is empty")
	}
	logFile, err := os.OpenFile(p.LogPath, os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("apppaths: create log file %q: %w", p.LogPath, err)
	}
	if err := logFile.Close(); err != nil {
		return fmt.Errorf("apppaths: close log file %q: %w", p.LogPath, err)
	}
	return nil
}
