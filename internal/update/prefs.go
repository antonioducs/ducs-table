package update

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

// preferences are global (not per project) and live beside the workspace in
// Application Support so the scheduler can read them before the UI loads.
type preferences struct {
	AutoCheck      *bool  `json:"autoCheck,omitempty"`
	SkippedVersion string `json:"skippedVersion,omitempty"`
}

func (p preferences) autoCheck() bool { return p.AutoCheck == nil || *p.AutoCheck }

func loadPreferences(path string) (preferences, error) {
	var prefs preferences
	if path == "" {
		return prefs, nil
	}
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return prefs, nil
	}
	if err != nil {
		return prefs, fmt.Errorf("read update preferences: %w", err)
	}
	if err := json.Unmarshal(data, &prefs); err != nil {
		return preferences{}, fmt.Errorf("parse update preferences: %w", err)
	}
	return prefs, nil
}

func savePreferences(path string, prefs preferences) error {
	if path == "" {
		return nil
	}
	data, err := json.MarshalIndent(prefs, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("create update preferences directory: %w", err)
	}
	temp, err := os.CreateTemp(filepath.Dir(path), ".update-preferences-*.json")
	if err != nil {
		return fmt.Errorf("write update preferences: %w", err)
	}
	tempPath := temp.Name()
	defer os.Remove(tempPath)
	if _, err := temp.Write(append(data, '\n')); err != nil {
		_ = temp.Close()
		return fmt.Errorf("write update preferences: %w", err)
	}
	if err := temp.Chmod(0o600); err != nil {
		_ = temp.Close()
		return fmt.Errorf("write update preferences: %w", err)
	}
	if err := temp.Close(); err != nil {
		return fmt.Errorf("write update preferences: %w", err)
	}
	if err := os.Rename(tempPath, path); err != nil {
		return fmt.Errorf("write update preferences: %w", err)
	}
	return nil
}
