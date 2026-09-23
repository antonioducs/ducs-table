package update

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	goruntime "runtime"
	"sync"
	"time"
)

const (
	DefaultOwner = "antonioducs"
	DefaultRepo  = "ducs-table"

	progressEmitInterval = 150 * time.Millisecond
)

// Logger is satisfied by *applog.Logger.
type Logger interface {
	Info(event string, attrs ...any)
	Error(event string, err error, redactValues []string, attrs ...any) string
}

type noopLogger struct{}

func (noopLogger) Info(string, ...any)                          {}
func (noopLogger) Error(string, error, []string, ...any) string { return "" }

// Config wires the service to the running app. Zero values select production
// defaults; tests override the network, filesystem, and tool seams.
type Config struct {
	CurrentVersion string
	// BuildType is the Wails runtime build type; only "production" updates.
	BuildType string
	// Fixture simulates a state for UI work in non-production builds:
	// available, downloading, ready, manual, notify, or error.
	Fixture string

	Owner             string
	Repo              string
	APIBaseURL        string
	DownloadHost      string
	AllowInsecureHTTP bool

	CacheDir        string
	PreferencesPath string
	Executable      string
	PID             int
	GOARCH          string

	HTTPClient *http.Client
	Tools      Tools
	Logger     Logger
	Emit       func(State)
	Now        func() time.Time

	InitialDelay     time.Duration
	Interval         time.Duration
	CheckTimeout     time.Duration
	StallTimeout     time.Duration
	MaxDownloadBytes int64
}

// Service owns the update state machine. All exported methods are safe for
// concurrent use; long work runs on the context passed to Start.
type Service struct {
	cfg    Config
	client *http.Client
	tools  Tools
	log    Logger

	mu          sync.Mutex
	ctx         context.Context
	started     bool
	fixture     bool
	state       State
	prefs       preferences
	bundle      string
	identity    Identity
	baseMode    Mode
	baseReason  string
	latest      release
	asset       releaseAsset
	hasAsset    bool
	readyApp    string
	lastChecked time.Time
	lastEmit    time.Time
}

func New(cfg Config) *Service {
	if cfg.Owner == "" {
		cfg.Owner = DefaultOwner
	}
	if cfg.Repo == "" {
		cfg.Repo = DefaultRepo
	}
	if cfg.APIBaseURL == "" {
		cfg.APIBaseURL = "https://api.github.com"
	}
	if cfg.DownloadHost == "" {
		cfg.DownloadHost = "github.com"
	}
	if cfg.GOARCH == "" {
		cfg.GOARCH = goruntime.GOARCH
	}
	if cfg.PID == 0 {
		cfg.PID = os.Getpid()
	}
	if cfg.Executable == "" {
		cfg.Executable, _ = os.Executable()
	}
	if cfg.Tools == nil {
		cfg.Tools = SystemTools{}
	}
	if cfg.Logger == nil {
		cfg.Logger = noopLogger{}
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.InitialDelay <= 0 {
		cfg.InitialDelay = 10 * time.Second
	}
	if cfg.Interval <= 0 {
		cfg.Interval = 6 * time.Hour
	}
	if cfg.CheckTimeout <= 0 {
		cfg.CheckTimeout = 15 * time.Second
	}
	if cfg.StallTimeout <= 0 {
		cfg.StallTimeout = time.Minute
	}
	if cfg.MaxDownloadBytes <= 0 {
		cfg.MaxDownloadBytes = 2 << 30
	}
	client := cfg.HTTPClient
	if client == nil {
		client = newHTTPClient(cfg.AllowInsecureHTTP)
	}
	return &Service{
		cfg:      cfg,
		client:   client,
		tools:    cfg.Tools,
		log:      cfg.Logger,
		ctx:      context.Background(),
		baseMode: ModeOff,
		state:    State{Phase: PhaseIdle, Mode: ModeOff, CurrentVersion: cfg.CurrentVersion, AutoCheck: true},
	}
}

// Start resolves what this installation can do, removes leftovers from a
// previous update, and schedules automatic checks. It never contacts the
// network synchronously.
func (s *Service) Start(ctx context.Context) {
	s.mu.Lock()
	if s.started {
		s.mu.Unlock()
		return
	}
	s.started = true
	s.ctx = ctx
	prefs, err := loadPreferences(s.cfg.PreferencesPath)
	if err != nil {
		s.log.Error("update_preferences_unreadable", err, nil)
	}
	s.prefs = prefs
	s.state.AutoCheck = prefs.autoCheck()
	s.state.SkippedVersion = prefs.SkippedVersion
	s.resolveModeLocked(ctx)
	fixture := s.applyFixtureLocked()
	mode := s.state.Mode
	s.emitLocked()
	s.mu.Unlock()

	if fixture || mode == ModeOff {
		return
	}
	s.log.Info("update_service_started", "mode", string(mode), "auto_check", prefs.autoCheck())
	s.removeLeftovers()
	go s.schedule(ctx)
}

func (s *Service) State() State {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.state
}

func (s *Service) resolveModeLocked(ctx context.Context) {
	set := func(mode Mode, reason string) {
		s.baseMode, s.baseReason = mode, reason
		s.state.Mode, s.state.ModeReason = mode, reason
	}
	if s.cfg.BuildType != "production" {
		set(ModeOff, "Updates are disabled in development builds.")
		return
	}
	if _, err := ParseVersion(s.cfg.CurrentVersion); err != nil {
		set(ModeOff, "The app version could not be determined.")
		return
	}
	bundle, ok := bundlePath(s.cfg.Executable)
	if !ok {
		set(ModeNotify, "Duc's Table is not running from an app bundle.")
		return
	}
	s.bundle = bundle
	identity, err := s.tools.SigningIdentity(ctx, bundle)
	if err != nil || identity.Identifier == "" || identity.TeamID == "" {
		set(ModeNotify, "This build is not signed with a Developer ID, so updates cannot be verified automatically.")
		return
	}
	s.identity = identity
	if translocated(bundle) {
		set(ModeManual, "Move Duc's Table to the Applications folder to install updates automatically.")
		return
	}
	if err := probeWritable(filepath.Dir(bundle)); err != nil {
		set(ModeManual, fmt.Sprintf("Duc's Table does not have permission to replace itself in %s.", filepath.Dir(bundle)))
		return
	}
	set(ModeInstaller, "")
}

func (s *Service) schedule(ctx context.Context) {
	timer := time.NewTimer(s.cfg.InitialDelay)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			if s.State().AutoCheck {
				s.Check(ctx, false)
			}
			timer.Reset(s.cfg.Interval)
		}
	}
}

// Check asks GitHub for the latest release. Failures are reported in the
// returned state and never block the app. A manual check also shows a
// version the user previously skipped.
func (s *Service) Check(ctx context.Context, manual bool) State {
	s.mu.Lock()
	// A verified update waiting for restart is not interrupted by scheduled
	// checks, which would briefly make "Restart to update" unavailable.
	if s.fixture || s.baseMode == ModeOff || s.state.busy() || (!manual && s.state.Phase == PhaseReady) {
		defer s.mu.Unlock()
		return s.state
	}
	previous := s.state.Phase
	s.state.Phase = PhaseChecking
	s.state.Error = ""
	s.emitLocked()
	s.mu.Unlock()

	latest, err := s.fetchLatestRelease(ctx)

	s.mu.Lock()
	defer s.mu.Unlock()
	defer s.emitLocked()
	now := s.cfg.Now()
	s.lastChecked = now
	s.state.LastCheckedAt = now.UTC().Format(time.RFC3339)
	switch {
	case errors.Is(err, errNoPublishedRelease):
		s.clearAvailableLocked()
	case err != nil:
		s.state.Phase = previous
		if ctx.Err() == nil {
			s.state.Error = "Could not check for updates: " + err.Error()
			s.log.Error("update_check_failed", err, nil)
		}
	default:
		s.applyReleaseLocked(latest, manual)
	}
	return s.state
}

func (s *Service) applyReleaseLocked(latest release, manual bool) {
	version, err := ParseVersion(latest.TagName)
	current, _ := ParseVersion(s.cfg.CurrentVersion)
	if err != nil || latest.Draft || latest.Prerelease || version.Prerelease != "" || version.Compare(current) <= 0 {
		s.clearAvailableLocked()
		s.log.Info("update_check_completed", "result", "up_to_date")
		return
	}
	versionText := version.String()
	if skipped := s.prefs.SkippedVersion; skipped != "" {
		skippedVersion, parseErr := ParseVersion(skipped)
		switch {
		case parseErr != nil || version.Compare(skippedVersion) > 0:
			s.prefs.SkippedVersion = ""
			s.state.SkippedVersion = ""
			s.savePreferencesLocked()
		case !manual:
			s.clearAvailableLocked()
			s.log.Info("update_check_completed", "result", "skipped", "version", versionText)
			return
		}
	}
	if s.state.AvailableVersion != "" && s.state.AvailableVersion != versionText {
		s.discardCacheLocked()
	}
	s.latest = latest
	s.asset, s.hasAsset = assetFor(latest, versionText, s.cfg.GOARCH)
	s.state.Mode, s.state.ModeReason = s.baseMode, s.baseReason
	if !s.hasAsset && s.baseMode != ModeNotify {
		s.state.Mode = ModeNotify
		s.state.ModeReason = "This release does not include a package for this Mac's architecture."
	}
	s.state.AvailableVersion = versionText
	s.state.ReleaseURL = latest.HTMLURL
	if !s.releasePageAllowed(latest.HTMLURL) {
		s.state.ReleaseURL = s.fallbackReleaseURL(versionText)
	}
	s.state.PublishedAt = ""
	if !latest.PublishedAt.IsZero() {
		s.state.PublishedAt = latest.PublishedAt.UTC().Format(time.RFC3339)
	}
	s.log.Info("update_check_completed", "result", "available", "version", versionText, "mode", string(s.state.Mode))
	if s.readyApp != "" {
		s.state.Phase = PhaseReady
		return
	}
	s.state.Phase = PhaseAvailable
	// A package downloaded before a restart is re-verified instead of fetched
	// again; the user already chose to download this version.
	if s.state.Mode != ModeNotify && hasCachedApp(filepath.Join(s.cfg.CacheDir, versionText)) {
		s.startDownloadLocked()
	}
}

// Download starts fetching and verifying the available update in the
// background. Progress is reported through Emit.
func (s *Service) Download() (State, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.fixture {
		s.state.Phase = PhaseReady
		s.state.Error = ""
		s.emitLocked()
		return s.state, nil
	}
	switch s.state.Phase {
	case PhaseDownloading, PhaseVerifying, PhaseReady:
		return s.state, nil
	case PhaseAvailable:
	default:
		return s.state, errors.New("no update is available to download")
	}
	if !s.hasAsset || (s.state.Mode != ModeInstaller && s.state.Mode != ModeManual) {
		return s.state, errors.New("this installation cannot download updates automatically; open the release page instead")
	}
	s.startDownloadLocked()
	return s.state, nil
}

func (s *Service) startDownloadLocked() {
	version, latest, asset := s.state.AvailableVersion, s.latest, s.asset
	s.state.Phase = PhaseDownloading
	s.state.Error = ""
	s.state.DownloadedBytes, s.state.TotalBytes, s.state.Progress = 0, asset.Size, 0
	s.emitLocked()
	go s.runDownload(s.ctx, version, latest, asset)
}

func (s *Service) runDownload(ctx context.Context, version string, latest release, asset releaseAsset) {
	dir := filepath.Join(s.cfg.CacheDir, version)
	app, err := s.prepareUpdate(ctx, dir, version, latest, asset)

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.state.AvailableVersion != version || ctx.Err() != nil {
		return
	}
	defer s.emitLocked()
	if err != nil {
		_ = os.RemoveAll(dir)
		s.state.Phase = PhaseAvailable
		s.state.DownloadedBytes, s.state.Progress = 0, 0
		s.state.Error = "The update could not be downloaded and verified: " + err.Error()
		s.log.Error("update_download_failed", err, nil, "version", version)
		return
	}
	s.readyApp = app
	s.state.Phase = PhaseReady
	s.state.DownloadedBytes, s.state.Progress = asset.Size, 100
	s.log.Info("update_ready", "version", version, "mode", string(s.state.Mode))
}

// Install replaces the running bundle with the verified update and starts a
// helper that reopens the app once this process exits. The caller must quit
// the app after a nil error.
func (s *Service) Install(ctx context.Context) (State, error) {
	s.mu.Lock()
	if s.fixture {
		defer s.mu.Unlock()
		return s.state, errors.New("simulated update: nothing was installed")
	}
	if s.state.Phase != PhaseReady || s.readyApp == "" {
		defer s.mu.Unlock()
		return s.state, errors.New("no verified update is ready to install")
	}
	if s.state.Mode != ModeInstaller {
		defer s.mu.Unlock()
		return s.state, errors.New("this installation cannot replace itself; reveal the update in Finder instead")
	}
	app, target, version := s.readyApp, s.bundle, s.state.AvailableVersion
	s.state.Phase = PhaseInstalling
	s.state.Error = ""
	s.emitLocked()
	s.mu.Unlock()

	err := s.replaceBundle(ctx, app, target)

	s.mu.Lock()
	defer s.mu.Unlock()
	defer s.emitLocked()
	if err != nil {
		s.state.Phase = PhaseReady
		if errors.Is(err, fs.ErrPermission) {
			s.baseMode = ModeManual
			s.baseReason = fmt.Sprintf("Duc's Table does not have permission to replace itself in %s.", filepath.Dir(target))
			s.state.Mode, s.state.ModeReason = s.baseMode, s.baseReason
		}
		s.state.Error = "The update could not be installed: " + err.Error()
		s.log.Error("update_install_failed", err, nil, "version", version)
		return s.state, err
	}
	s.readyApp = ""
	s.log.Info("update_installed", "version", version)
	if err := s.tools.Relaunch(s.cfg.PID, target); err != nil {
		s.log.Error("update_relaunch_failed", err, nil)
	}
	return s.state, nil
}

// Skip hides the available version from automatic checks until a newer one
// is published.
func (s *Service) Skip() (State, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.state.AvailableVersion == "" {
		return s.state, nil
	}
	if s.state.busy() {
		return s.state, errors.New("wait for the current update step to finish")
	}
	s.prefs.SkippedVersion = s.state.AvailableVersion
	s.state.SkippedVersion = s.state.AvailableVersion
	if !s.fixture {
		s.savePreferencesLocked()
	}
	s.clearAvailableLocked()
	s.emitLocked()
	return s.state, nil
}

// SetAutoCheck persists the preference and checks soon when re-enabled after
// the regular interval has elapsed.
func (s *Service) SetAutoCheck(enabled bool) (State, error) {
	s.mu.Lock()
	s.prefs.AutoCheck = &enabled
	s.state.AutoCheck = enabled
	var err error
	if !s.fixture {
		err = savePreferences(s.cfg.PreferencesPath, s.prefs)
	}
	s.emitLocked()
	state := s.state
	due := enabled && !s.fixture && s.baseMode != ModeOff && (s.lastChecked.IsZero() || s.cfg.Now().Sub(s.lastChecked) >= s.cfg.Interval)
	ctx := s.ctx
	s.mu.Unlock()
	if due {
		go s.Check(ctx, false)
	}
	return state, err
}

// ReleaseURL returns the GitHub page for the available (or latest) release.
func (s *Service) ReleaseURL() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.state.ReleaseURL != "" {
		return s.state.ReleaseURL
	}
	return fmt.Sprintf("https://github.com/%s/%s/releases/latest", s.cfg.Owner, s.cfg.Repo)
}

// Reveal shows the verified update in Finder for manual installation.
func (s *Service) Reveal() error {
	s.mu.Lock()
	app := s.readyApp
	s.mu.Unlock()
	if app == "" {
		return errors.New("no verified update is ready")
	}
	return s.tools.Reveal(app)
}

func (s *Service) clearAvailableLocked() {
	s.discardCacheLocked()
	s.state.Phase = PhaseIdle
	s.state.AvailableVersion, s.state.ReleaseURL, s.state.PublishedAt = "", "", ""
	s.state.DownloadedBytes, s.state.TotalBytes, s.state.Progress = 0, 0, 0
	s.state.Mode, s.state.ModeReason = s.baseMode, s.baseReason
	s.latest, s.asset, s.hasAsset = release{}, releaseAsset{}, false
}

// discardCacheLocked deletes any package downloaded for the currently
// available version (it must run before AvailableVersion changes).
func (s *Service) discardCacheLocked() {
	s.readyApp = ""
	if s.fixture || s.state.AvailableVersion == "" || s.cfg.CacheDir == "" {
		return
	}
	if err := os.RemoveAll(filepath.Join(s.cfg.CacheDir, s.state.AvailableVersion)); err != nil {
		s.log.Error("update_cache_cleanup_failed", err, nil)
	}
}

func (s *Service) savePreferencesLocked() {
	if err := savePreferences(s.cfg.PreferencesPath, s.prefs); err != nil {
		s.log.Error("update_preferences_save_failed", err, nil)
	}
}

func (s *Service) setPhase(phase Phase) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.state.Phase = phase
	s.emitLocked()
}

func (s *Service) reportProgress(downloaded, total int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.state.DownloadedBytes, s.state.TotalBytes = downloaded, total
	if total > 0 {
		s.state.Progress = float64(downloaded) * 100 / float64(total)
	}
	if now := time.Now(); now.Sub(s.lastEmit) >= progressEmitInterval || downloaded == total {
		s.emitLocked()
	}
}

// emitLocked is called with mu held so events reach the frontend in order.
func (s *Service) emitLocked() {
	s.state.Revision++
	s.lastEmit = time.Now()
	if s.cfg.Emit != nil {
		s.cfg.Emit(s.state)
	}
}

func (s *Service) userAgent() string {
	return fmt.Sprintf("DucsTable/%s (+https://github.com/%s/%s)", s.cfg.CurrentVersion, s.cfg.Owner, s.cfg.Repo)
}

func (s *Service) fallbackReleaseURL(version string) string {
	return fmt.Sprintf("https://github.com/%s/%s/releases/tag/v%s", s.cfg.Owner, s.cfg.Repo, version)
}

func (s *Service) applyFixtureLocked() bool {
	if s.cfg.Fixture == "" || s.cfg.BuildType == "production" {
		return false
	}
	current, err := ParseVersion(s.cfg.CurrentVersion)
	if err != nil {
		return false
	}
	next := Version{Major: current.Major, Minor: current.Minor, Patch: current.Patch + 1}.String()
	state := s.state
	state.Mode, state.ModeReason = ModeInstaller, ""
	state.AvailableVersion = next
	state.ReleaseURL = s.fallbackReleaseURL(next)
	state.LastCheckedAt = s.cfg.Now().UTC().Format(time.RFC3339)
	state.PublishedAt = state.LastCheckedAt
	switch s.cfg.Fixture {
	case "available":
		state.Phase = PhaseAvailable
	case "downloading":
		state.Phase = PhaseDownloading
		state.TotalBytes, state.DownloadedBytes, state.Progress = 272_793_667, 109_117_467, 40
	case "ready":
		state.Phase = PhaseReady
	case "manual":
		state.Phase = PhaseReady
		state.Mode, state.ModeReason = ModeManual, "Move Duc's Table to the Applications folder to install updates automatically."
	case "notify":
		state.Phase = PhaseAvailable
		state.Mode, state.ModeReason = ModeNotify, "This build is not signed with a Developer ID, so updates cannot be verified automatically."
	case "error":
		state.Phase = PhaseAvailable
		state.Error = "The update could not be downloaded and verified: simulated failure"
	default:
		return false
	}
	s.fixture = true
	s.state = state
	return true
}
