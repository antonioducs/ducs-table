package main

import (
	_ "embed"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"ducs-table/internal/apppaths"
	"ducs-table/internal/models"
	"ducs-table/internal/update"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// wails.json is the release workflow's source of truth for the app version
// (it must match the tag and CFBundleShortVersionString), so the running app
// reads its own version from the same file.
//
//go:embed wails.json
var wailsConfig []byte

func appVersion() string {
	var config struct {
		Info struct {
			ProductVersion string `json:"productVersion"`
		} `json:"info"`
	}
	if err := json.Unmarshal(wailsConfig, &config); err != nil {
		return ""
	}
	return config.Info.ProductVersion
}

func (a *App) startUpdates(paths apppaths.Paths) {
	a.updates = update.New(update.Config{
		CurrentVersion:  appVersion(),
		BuildType:       runtime.Environment(a.ctx).BuildType,
		Fixture:         os.Getenv("DUCS_UPDATE_FIXTURE"),
		CacheDir:        filepath.Join(paths.BaseDir, "updates"),
		PreferencesPath: filepath.Join(paths.BaseDir, "update-preferences.json"),
		Logger:          a.logger,
		Emit:            func(state update.State) { a.emit("ducs:update-status", state) },
	})
	a.updates.Start(a.ctx)
}

func (a *App) UpdateGetState() update.State {
	if a.updates == nil {
		return update.State{Phase: update.PhaseIdle, Mode: update.ModeOff, CurrentVersion: appVersion()}
	}
	return a.updates.State()
}

// UpdateCheck always contacts GitHub, even when automatic checks are off or
// the available version was skipped, because the user asked explicitly.
func (a *App) UpdateCheck() update.State {
	if a.updates == nil {
		return a.UpdateGetState()
	}
	return a.updates.Check(a.ctx, true)
}

func (a *App) UpdateDownload() (update.State, error) {
	if a.updates == nil {
		return a.UpdateGetState(), updateUnavailable()
	}
	state, err := a.updates.Download()
	return state, updateError(err)
}

// UpdateInstall swaps the app bundle and quits; a helper reopens the new
// version once this process has exited.
func (a *App) UpdateInstall() (update.State, error) {
	if a.updates == nil {
		return a.UpdateGetState(), updateUnavailable()
	}
	state, err := a.updates.Install(a.ctx)
	if err != nil {
		return state, updateError(err)
	}
	go func() {
		// Let the binding response reach the frontend before shutdown starts.
		time.Sleep(200 * time.Millisecond)
		runtime.Quit(a.ctx)
	}()
	return state, nil
}

func (a *App) UpdateSkip() (update.State, error) {
	if a.updates == nil {
		return a.UpdateGetState(), updateUnavailable()
	}
	state, err := a.updates.Skip()
	return state, updateError(err)
}

func (a *App) UpdateSetAutoCheck(enabled bool) (update.State, error) {
	if a.updates == nil {
		return a.UpdateGetState(), updateUnavailable()
	}
	state, err := a.updates.SetAutoCheck(enabled)
	if err != nil {
		return state, models.WrapError(models.CodeIO, "The update preference could not be saved", err, nil)
	}
	return state, nil
}

func (a *App) UpdateOpenRelease() error {
	if a.updates == nil || a.ctx == nil {
		return updateUnavailable()
	}
	runtime.BrowserOpenURL(a.ctx, a.updates.ReleaseURL())
	return nil
}

func (a *App) UpdateReveal() error {
	if a.updates == nil {
		return updateUnavailable()
	}
	return updateError(a.updates.Reveal())
}

func updateUnavailable() error {
	return models.NewError(models.CodeConflict, "Updates are unavailable in this session", nil)
}

func updateError(err error) error {
	if err == nil {
		return nil
	}
	message := err.Error()
	first, size := utf8.DecodeRuneInString(message)
	message = string(unicode.ToUpper(first)) + message[size:]
	return models.WrapError(models.CodeConflict, strings.TrimSuffix(message, "."), err, nil)
}
