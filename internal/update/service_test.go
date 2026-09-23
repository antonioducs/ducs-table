package update

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	goruntime "runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const testBundleID = "com.wails.ducs-table"

type releaseServer struct {
	*httptest.Server
	mu           sync.Mutex
	tag          string
	prerelease   bool
	arch         string
	payload      []byte
	digest       string
	checksumFile string
	status       int
	requests     atomic.Int32
}

func newReleaseServer(t *testing.T, tag string) *releaseServer {
	t.Helper()
	payload := []byte("signed app archive for " + tag)
	sum := sha256.Sum256(payload)
	server := &releaseServer{tag: tag, arch: "ARM64", payload: payload, digest: "sha256:" + hex.EncodeToString(sum[:])}
	server.Server = httptest.NewServer(http.HandlerFunc(server.serve))
	t.Cleanup(server.Close)
	return server
}

func (r *releaseServer) serve(writer http.ResponseWriter, request *http.Request) {
	r.requests.Add(1)
	r.mu.Lock()
	defer r.mu.Unlock()
	switch request.URL.Path {
	case "/repos/antonioducs/ducs-table/releases/latest":
		if r.status != 0 {
			writer.WriteHeader(r.status)
			return
		}
		version := strings.TrimPrefix(r.tag, "v")
		archive := fmt.Sprintf("DucsTable-%s-macOS-%s.zip", version, r.arch)
		assets := []releaseAsset{{Name: archive, Size: int64(len(r.payload)), URL: r.URL + "/download/archive", Digest: r.digest, State: "uploaded"}}
		if r.checksumFile != "" {
			assets = append(assets, releaseAsset{Name: archive + ".sha256", Size: int64(len(r.checksumFile)), URL: r.URL + "/download/checksum", State: "uploaded"})
		}
		_ = json.NewEncoder(writer).Encode(map[string]any{
			"tag_name":     r.tag,
			"html_url":     "https://github.com/antonioducs/ducs-table/releases/tag/" + r.tag,
			"prerelease":   r.prerelease,
			"published_at": "2026-09-22T12:00:00Z",
			"assets":       assets,
		})
	case "/download/archive":
		_, _ = writer.Write(r.payload)
	case "/download/checksum":
		_, _ = writer.Write([]byte(r.checksumFile))
	default:
		http.NotFound(writer, request)
	}
}

func (r *releaseServer) set(update func(*releaseServer)) {
	r.mu.Lock()
	defer r.mu.Unlock()
	update(r)
}

type fakeTools struct {
	mu           sync.Mutex
	identity     Identity
	identityErr  error
	info         BundleInfo
	verify       func(bundle, requirement string) error
	gatekeeper   error
	requirements []string
	relaunched   []string
	relaunchPID  int
	revealed     []string
}

func newFakeTools() *fakeTools {
	return &fakeTools{
		identity: Identity{Identifier: testBundleID, TeamID: "TEAM123456"},
		info:     BundleInfo{Identifier: testBundleID, Version: "0.2.0"},
	}
}

func (f *fakeTools) SigningIdentity(context.Context, string) (Identity, error) {
	return f.identity, f.identityErr
}

func (f *fakeTools) BundleInfo(context.Context, string) (BundleInfo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.info, nil
}

func (f *fakeTools) VerifySignature(_ context.Context, bundle, requirement string) error {
	f.mu.Lock()
	f.requirements = append(f.requirements, requirement)
	verify := f.verify
	f.mu.Unlock()
	if verify != nil {
		return verify(bundle, requirement)
	}
	return nil
}

func (f *fakeTools) AssessGatekeeper(context.Context, string) error { return f.gatekeeper }

func (f *fakeTools) Extract(_ context.Context, archive, destination string) error {
	payload, err := os.ReadFile(archive)
	if err != nil {
		return err
	}
	return writeBundle(filepath.Join(destination, "Duc's Table.app"), string(payload))
}

func (f *fakeTools) Copy(_ context.Context, source, destination string) error {
	return os.Rename(source, destination)
}

func (f *fakeTools) Reveal(bundle string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.revealed = append(f.revealed, bundle)
	return nil
}

func (f *fakeTools) Relaunch(pid int, bundle string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.relaunchPID = pid
	f.relaunched = append(f.relaunched, bundle)
	return nil
}

func writeBundle(bundle, marker string) error {
	binary := filepath.Join(bundle, "Contents", "MacOS", "DucsTable")
	if err := os.MkdirAll(filepath.Dir(binary), 0o755); err != nil {
		return err
	}
	return os.WriteFile(binary, []byte(marker), 0o755)
}

func readBundleMarker(t *testing.T, bundle string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(bundle, "Contents", "MacOS", "DucsTable"))
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

type harness struct {
	service *Service
	config  Config
	bundle  string
	events  *eventLog
}

type eventLog struct {
	mu     sync.Mutex
	states []State
}

func (e *eventLog) record(state State) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.states = append(e.states, state)
}

func (e *eventLog) phases() []Phase {
	e.mu.Lock()
	defer e.mu.Unlock()
	result := make([]Phase, 0, len(e.states))
	for _, state := range e.states {
		if len(result) == 0 || result[len(result)-1] != state.Phase {
			result = append(result, state.Phase)
		}
	}
	return result
}

func tempRoot(t *testing.T) string {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return root
}

func newHarness(t *testing.T, server *releaseServer, tools *fakeTools, adjust func(*Config)) *harness {
	t.Helper()
	root := tempRoot(t)
	bundle := filepath.Join(root, "Applications", "Duc's Table.app")
	if err := writeBundle(bundle, "installed 0.1.2"); err != nil {
		t.Fatal(err)
	}
	events := &eventLog{}
	config := Config{
		CurrentVersion:    "0.1.2",
		BuildType:         "production",
		APIBaseURL:        server.URL,
		DownloadHost:      "127.0.0.1",
		AllowInsecureHTTP: true,
		CacheDir:          filepath.Join(root, "support", "updates"),
		PreferencesPath:   filepath.Join(root, "support", "update-preferences.json"),
		Executable:        filepath.Join(bundle, "Contents", "MacOS", "DucsTable"),
		PID:               4242,
		GOARCH:            "arm64",
		Tools:             tools,
		Emit:              events.record,
		InitialDelay:      time.Hour,
		Interval:          time.Hour,
		CheckTimeout:      5 * time.Second,
	}
	if adjust != nil {
		adjust(&config)
	}
	return startHarness(t, config, bundle, events)
}

func startHarness(t *testing.T, config Config, bundle string, events *eventLog) *harness {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	service := New(config)
	service.Start(ctx)
	return &harness{service: service, config: config, bundle: bundle, events: events}
}

func waitSettled(t *testing.T, service *Service) State {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if state := service.State(); !state.busy() {
			return state
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("update service did not settle: %+v", service.State())
	return State{}
}

func TestStartResolvesWhatTheInstallationCanDo(t *testing.T) {
	server := newReleaseServer(t, "v0.2.0")

	installer := newHarness(t, server, newFakeTools(), nil)
	if state := installer.service.State(); state.Mode != ModeInstaller || state.ModeReason != "" || !state.AutoCheck || state.CurrentVersion != "0.1.2" {
		t.Fatalf("signed writable bundle state = %+v", state)
	}

	dev := newHarness(t, server, newFakeTools(), func(config *Config) { config.BuildType = "dev" })
	if state := dev.service.Check(context.Background(), true); state.Mode != ModeOff || state.Phase != PhaseIdle {
		t.Fatalf("development build state = %+v", state)
	}
	if server.requests.Load() != 0 {
		t.Fatalf("development builds must not contact GitHub; got %d requests", server.requests.Load())
	}

	unsigned := newFakeTools()
	unsigned.identity = Identity{Identifier: testBundleID}
	if state := newHarness(t, server, unsigned, nil).service.State(); state.Mode != ModeNotify || !strings.Contains(state.ModeReason, "Developer ID") {
		t.Fatalf("ad hoc build state = %+v", state)
	}

	loose := newHarness(t, server, newFakeTools(), func(config *Config) { config.Executable = filepath.Join(tempRoot(t), "DucsTable") })
	if state := loose.service.State(); state.Mode != ModeNotify {
		t.Fatalf("binary outside a bundle state = %+v", state)
	}

	translocatedRoot := filepath.Join(tempRoot(t), "AppTranslocation", "0A1B", "d", "Duc's Table.app")
	if err := writeBundle(translocatedRoot, "translocated"); err != nil {
		t.Fatal(err)
	}
	moved := newHarness(t, server, newFakeTools(), func(config *Config) {
		config.Executable = filepath.Join(translocatedRoot, "Contents", "MacOS", "DucsTable")
	})
	if state := moved.service.State(); state.Mode != ModeManual || !strings.Contains(state.ModeReason, "Applications") {
		t.Fatalf("translocated bundle state = %+v", state)
	}
}

func TestStartFallsBackToManualWhenTheAppFolderIsReadOnly(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root ignores directory permissions")
	}
	server := newReleaseServer(t, "v0.2.0")
	root := tempRoot(t)
	apps := filepath.Join(root, "Applications")
	bundle := filepath.Join(apps, "Duc's Table.app")
	if err := writeBundle(bundle, "installed"); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(apps, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(apps, 0o755) })
	h := newHarness(t, server, newFakeTools(), func(config *Config) {
		config.Executable = filepath.Join(bundle, "Contents", "MacOS", "DucsTable")
	})
	if state := h.service.State(); state.Mode != ModeManual || !strings.Contains(state.ModeReason, "permission") {
		t.Fatalf("read-only folder state = %+v", state)
	}
}

func TestCheckReportsOnlyNewerStableReleases(t *testing.T) {
	server := newReleaseServer(t, "v0.2.0")
	h := newHarness(t, server, newFakeTools(), nil)

	state := h.service.Check(context.Background(), false)
	if state.Phase != PhaseAvailable || state.AvailableVersion != "0.2.0" || state.Mode != ModeInstaller || state.LastCheckedAt == "" {
		t.Fatalf("newer release state = %+v", state)
	}
	if state.ReleaseURL != "https://github.com/antonioducs/ducs-table/releases/tag/v0.2.0" || state.PublishedAt != "2026-09-22T12:00:00Z" {
		t.Fatalf("release metadata = %+v", state)
	}

	server.set(func(r *releaseServer) { r.tag = "v0.1.2" })
	if state := h.service.Check(context.Background(), false); state.Phase != PhaseIdle || state.AvailableVersion != "" {
		t.Fatalf("same version state = %+v", state)
	}

	server.set(func(r *releaseServer) { r.tag = "v0.3.0-rc.1"; r.prerelease = true })
	if state := h.service.Check(context.Background(), false); state.Phase != PhaseIdle {
		t.Fatalf("prerelease state = %+v", state)
	}

	server.set(func(r *releaseServer) { r.status = http.StatusNotFound })
	if state := h.service.Check(context.Background(), false); state.Phase != PhaseIdle || state.Error != "" {
		t.Fatalf("no published release state = %+v", state)
	}
}

func TestCheckFailureIsReportedWithoutLosingAKnownUpdate(t *testing.T) {
	server := newReleaseServer(t, "v0.2.0")
	h := newHarness(t, server, newFakeTools(), nil)
	h.service.Check(context.Background(), false)

	server.set(func(r *releaseServer) { r.status = http.StatusForbidden })
	state := h.service.Check(context.Background(), true)
	if state.Phase != PhaseAvailable || state.AvailableVersion != "0.2.0" || !strings.Contains(state.Error, "rate limit") {
		t.Fatalf("failed check state = %+v", state)
	}
}

func TestSkippedVersionIsHiddenUntilANewerReleaseOrAManualCheck(t *testing.T) {
	server := newReleaseServer(t, "v0.2.0")
	h := newHarness(t, server, newFakeTools(), nil)
	h.service.Check(context.Background(), false)

	state, err := h.service.Skip()
	if err != nil || state.Phase != PhaseIdle || state.SkippedVersion != "0.2.0" {
		t.Fatalf("skip = %+v, %v", state, err)
	}
	if state := h.service.Check(context.Background(), false); state.Phase != PhaseIdle {
		t.Fatalf("automatic check showed a skipped version: %+v", state)
	}
	if state := h.service.Check(context.Background(), true); state.Phase != PhaseAvailable || state.SkippedVersion != "0.2.0" {
		t.Fatalf("manual check must show a skipped version: %+v", state)
	}

	restarted := startHarness(t, h.config, h.bundle, &eventLog{})
	if state := restarted.service.Check(context.Background(), false); state.Phase != PhaseIdle || state.SkippedVersion != "0.2.0" {
		t.Fatalf("skip was not persisted: %+v", state)
	}

	server.set(func(r *releaseServer) { r.tag = "v0.2.1" })
	state = restarted.service.Check(context.Background(), false)
	if state.Phase != PhaseAvailable || state.AvailableVersion != "0.2.1" || state.SkippedVersion != "" {
		t.Fatalf("newer release must clear the skip: %+v", state)
	}
}

func TestReleaseWithoutAPackageForThisArchitectureOnlyNotifies(t *testing.T) {
	server := newReleaseServer(t, "v0.2.0")
	server.set(func(r *releaseServer) { r.arch = "X64" })
	h := newHarness(t, server, newFakeTools(), nil)

	state := h.service.Check(context.Background(), false)
	if state.Phase != PhaseAvailable || state.Mode != ModeNotify || !strings.Contains(state.ModeReason, "architecture") {
		t.Fatalf("missing package state = %+v", state)
	}
	if _, err := h.service.Download(); err == nil {
		t.Fatal("download must be refused without a package for this architecture")
	}
}

func TestDownloadVerifiesChecksumSignatureAndGatekeeper(t *testing.T) {
	server := newReleaseServer(t, "v0.2.0")
	tools := newFakeTools()
	h := newHarness(t, server, tools, nil)
	h.service.Check(context.Background(), false)

	if state, err := h.service.Download(); err != nil || state.Phase != PhaseDownloading || state.TotalBytes != int64(len(server.payload)) {
		t.Fatalf("download start = %+v, %v", state, err)
	}
	state := waitSettled(t, h.service)
	if state.Phase != PhaseReady || state.Error != "" || state.Progress != 100 {
		t.Fatalf("download result = %+v", state)
	}
	phases := h.events.phases()
	if got := strings.Join(phasesToStrings(phases[len(phases)-3:]), ","); got != "downloading,verifying,ready" {
		t.Fatalf("phase sequence = %v", phases)
	}
	if len(tools.requirements) != 1 || !strings.Contains(tools.requirements[0], `identifier "com.wails.ducs-table"`) ||
		!strings.Contains(tools.requirements[0], `certificate leaf[subject.OU] = "TEAM123456"`) ||
		!strings.Contains(tools.requirements[0], "1.2.840.113635.100.6.2.6") {
		t.Fatalf("designated requirement = %q", tools.requirements)
	}
	if _, err := os.Stat(filepath.Join(h.config.CacheDir, "0.2.0", archiveName)); !os.IsNotExist(err) {
		t.Fatalf("archive must be removed after extraction: %v", err)
	}

	if err := h.service.Reveal(); err != nil || len(tools.revealed) != 1 || !strings.HasSuffix(tools.revealed[0], "Duc's Table.app") {
		t.Fatalf("reveal = %v, %v", tools.revealed, err)
	}
}

func TestDownloadFallsBackToThePublishedChecksumFile(t *testing.T) {
	server := newReleaseServer(t, "v0.2.0")
	sum := strings.TrimPrefix(server.digest, "sha256:")
	server.set(func(r *releaseServer) {
		r.digest = ""
		r.checksumFile = sum + "  DucsTable-0.2.0-macOS-ARM64.zip\n"
	})
	h := newHarness(t, server, newFakeTools(), nil)
	h.service.Check(context.Background(), false)
	if _, err := h.service.Download(); err != nil {
		t.Fatal(err)
	}
	if state := waitSettled(t, h.service); state.Phase != PhaseReady {
		t.Fatalf("checksum file download = %+v", state)
	}
}

func TestDownloadRejectsTamperedOrForeignPackages(t *testing.T) {
	cases := map[string]struct {
		server func(*releaseServer)
		tools  func(*fakeTools)
		want   string
	}{
		"checksum mismatch": {server: func(r *releaseServer) { r.digest = "sha256:" + strings.Repeat("0", 64) }, want: "checksum"},
		"no checksum":       {server: func(r *releaseServer) { r.digest = "" }, want: "SHA-256"},
		"other bundle":      {tools: func(f *fakeTools) { f.info.Identifier = "com.example.other" }, want: "bundle identifier"},
		"other version":     {tools: func(f *fakeTools) { f.info.Version = "0.1.9" }, want: "reports version"},
		"other team": {tools: func(f *fakeTools) {
			f.verify = func(string, string) error { return errors.New("requirement not satisfied") }
		}, want: "code signature"},
		"not notarized": {tools: func(f *fakeTools) { f.gatekeeper = errors.New("rejected") }, want: "Gatekeeper"},
	}
	for name, test := range cases {
		t.Run(name, func(t *testing.T) {
			server := newReleaseServer(t, "v0.2.0")
			if test.server != nil {
				server.set(test.server)
			}
			tools := newFakeTools()
			if test.tools != nil {
				test.tools(tools)
			}
			h := newHarness(t, server, tools, nil)
			h.service.Check(context.Background(), false)
			if _, err := h.service.Download(); err != nil {
				t.Fatal(err)
			}
			state := waitSettled(t, h.service)
			if state.Phase != PhaseAvailable || !strings.Contains(state.Error, test.want) {
				t.Fatalf("state = %+v; want error containing %q", state, test.want)
			}
			if _, err := os.Stat(filepath.Join(h.config.CacheDir, "0.2.0")); !os.IsNotExist(err) {
				t.Fatalf("rejected package must be deleted: %v", err)
			}
			if _, err := h.service.Install(context.Background()); err == nil {
				t.Fatal("a rejected package must not be installable")
			}
		})
	}
}

func TestInstallReplacesTheBundleRelaunchesAndCleansUpOnNextStart(t *testing.T) {
	server := newReleaseServer(t, "v0.2.0")
	tools := newFakeTools()
	h := newHarness(t, server, tools, nil)
	h.service.Check(context.Background(), false)
	if _, err := h.service.Download(); err != nil {
		t.Fatal(err)
	}
	waitSettled(t, h.service)

	state, err := h.service.Install(context.Background())
	if err != nil || state.Phase != PhaseInstalling {
		t.Fatalf("install = %+v, %v", state, err)
	}
	if got := readBundleMarker(t, h.bundle); got != string(server.payload) {
		t.Fatalf("installed bundle marker = %q", got)
	}
	previous := siblingPath(h.bundle, previousSuffix)
	if got := readBundleMarker(t, previous); got != "installed 0.1.2" {
		t.Fatalf("previous bundle marker = %q", got)
	}
	if len(tools.relaunched) != 1 || tools.relaunched[0] != h.bundle || tools.relaunchPID != 4242 {
		t.Fatalf("relaunch = %v pid %d", tools.relaunched, tools.relaunchPID)
	}

	next := h.config
	next.CurrentVersion = "0.2.0"
	startHarness(t, next, h.bundle, &eventLog{})
	if _, err := os.Stat(previous); !os.IsNotExist(err) {
		t.Fatalf("previous bundle must be removed once the new version starts: %v", err)
	}
	if entries, _ := os.ReadDir(h.config.CacheDir); len(entries) != 0 {
		t.Fatalf("installed version cache must be removed, found %d entries", len(entries))
	}
}

func TestInstallRollsBackWhenTheStagedBundleFailsVerification(t *testing.T) {
	server := newReleaseServer(t, "v0.2.0")
	tools := newFakeTools()
	h := newHarness(t, server, tools, nil)
	h.service.Check(context.Background(), false)
	if _, err := h.service.Download(); err != nil {
		t.Fatal(err)
	}
	waitSettled(t, h.service)
	tools.verify = func(bundle, _ string) error {
		if strings.HasSuffix(bundle, incomingSuffix) {
			return errors.New("modified after verification")
		}
		return nil
	}

	state, err := h.service.Install(context.Background())
	if err == nil || state.Phase != PhaseReady || !strings.Contains(state.Error, "code signature") {
		t.Fatalf("install = %+v, %v", state, err)
	}
	if got := readBundleMarker(t, h.bundle); got != "installed 0.1.2" {
		t.Fatalf("running bundle was modified: %q", got)
	}
	if _, err := os.Stat(siblingPath(h.bundle, incomingSuffix)); !os.IsNotExist(err) {
		t.Fatalf("staged bundle must be moved back: %v", err)
	}
	if !hasCachedApp(filepath.Join(h.config.CacheDir, "0.2.0")) {
		t.Fatal("verified update must remain available for another attempt")
	}
	if len(tools.relaunched) != 0 {
		t.Fatal("a failed install must not relaunch")
	}
}

func TestManualModeRevealsButNeverReplacesTheBundle(t *testing.T) {
	server := newReleaseServer(t, "v0.2.0")
	root := tempRoot(t)
	bundle := filepath.Join(root, "AppTranslocation", "X", "d", "Duc's Table.app")
	if err := writeBundle(bundle, "translocated"); err != nil {
		t.Fatal(err)
	}
	h := newHarness(t, server, newFakeTools(), func(config *Config) {
		config.Executable = filepath.Join(bundle, "Contents", "MacOS", "DucsTable")
	})
	h.service.Check(context.Background(), false)
	if _, err := h.service.Download(); err != nil {
		t.Fatal(err)
	}
	if state := waitSettled(t, h.service); state.Phase != PhaseReady || state.Mode != ModeManual {
		t.Fatalf("manual download = %+v", state)
	}
	if _, err := h.service.Install(context.Background()); err == nil {
		t.Fatal("manual mode must not replace the bundle")
	}
	if err := h.service.Reveal(); err != nil {
		t.Fatal(err)
	}
}

func TestVerifiedDownloadIsReusedAfterRestart(t *testing.T) {
	server := newReleaseServer(t, "v0.2.0")
	h := newHarness(t, server, newFakeTools(), nil)
	h.service.Check(context.Background(), false)
	if _, err := h.service.Download(); err != nil {
		t.Fatal(err)
	}
	waitSettled(t, h.service)

	server.set(func(r *releaseServer) { r.payload = []byte("must not be downloaded again") })
	restarted := startHarness(t, h.config, h.bundle, &eventLog{})
	restarted.service.Check(context.Background(), false)
	if state := waitSettled(t, restarted.service); state.Phase != PhaseReady {
		t.Fatalf("cached update state = %+v", state)
	}
}

func TestSkippingOrWithdrawingAReadyUpdateDeletesItsPackage(t *testing.T) {
	server := newReleaseServer(t, "v0.2.0")
	h := newHarness(t, server, newFakeTools(), nil)
	h.service.Check(context.Background(), false)
	if _, err := h.service.Download(); err != nil {
		t.Fatal(err)
	}
	waitSettled(t, h.service)
	cache := filepath.Join(h.config.CacheDir, "0.2.0")
	if !hasCachedApp(cache) {
		t.Fatal("verified update was not cached")
	}

	requests := server.requests.Load()
	if state := h.service.Check(context.Background(), false); state.Phase != PhaseReady || server.requests.Load() != requests {
		t.Fatalf("a scheduled check must not interrupt a ready update: %+v", state)
	}

	if _, err := h.service.Skip(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(cache); !os.IsNotExist(err) {
		t.Fatalf("skipped update package must be deleted: %v", err)
	}

	h.service.Check(context.Background(), true)
	if _, err := h.service.Download(); err != nil {
		t.Fatal(err)
	}
	waitSettled(t, h.service)
	server.set(func(r *releaseServer) { r.tag = "v0.1.2" })
	if state := h.service.Check(context.Background(), true); state.Phase != PhaseIdle {
		t.Fatalf("withdrawn release state = %+v", state)
	}
	if _, err := os.Stat(cache); !os.IsNotExist(err) {
		t.Fatalf("withdrawn update package must be deleted: %v", err)
	}
}

func TestAutoCheckPreferenceControlsTheSchedule(t *testing.T) {
	server := newReleaseServer(t, "v0.2.0")
	h := newHarness(t, server, newFakeTools(), func(config *Config) {
		config.InitialDelay = 10 * time.Millisecond
		config.Interval = 20 * time.Millisecond
	})
	deadline := time.Now().Add(5 * time.Second)
	for h.service.State().Phase != PhaseAvailable && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if h.service.State().Phase != PhaseAvailable {
		t.Fatal("automatic check did not run")
	}

	if state, err := h.service.SetAutoCheck(false); err != nil || state.AutoCheck {
		t.Fatalf("disable = %+v, %v", state, err)
	}
	waitSettled(t, h.service)
	before := server.requests.Load()
	time.Sleep(80 * time.Millisecond)
	if after := server.requests.Load(); after != before {
		t.Fatalf("disabled auto-check still contacted GitHub (%d -> %d)", before, after)
	}

	off := newHarness(t, server, newFakeTools(), func(config *Config) {
		config.PreferencesPath = h.config.PreferencesPath
		config.InitialDelay = 10 * time.Millisecond
	})
	time.Sleep(50 * time.Millisecond)
	if state := off.service.State(); state.AutoCheck || state.Phase != PhaseIdle {
		t.Fatalf("persisted opt-out was ignored: %+v", state)
	}
}

func TestFixtureSimulatesStatesOnlyOutsideProduction(t *testing.T) {
	server := newReleaseServer(t, "v0.2.0")
	h := newHarness(t, server, newFakeTools(), func(config *Config) {
		config.BuildType = "dev"
		config.Fixture = "available"
	})
	state := h.service.State()
	if state.Phase != PhaseAvailable || state.AvailableVersion != "0.1.3" || state.Mode != ModeInstaller {
		t.Fatalf("fixture state = %+v", state)
	}
	if state, _ := h.service.Download(); state.Phase != PhaseReady {
		t.Fatalf("fixture download = %+v", state)
	}
	if _, err := h.service.Install(context.Background()); err == nil {
		t.Fatal("fixture install must not touch the bundle")
	}
	if server.requests.Load() != 0 {
		t.Fatal("fixtures must not contact GitHub")
	}

	production := newHarness(t, server, newFakeTools(), func(config *Config) { config.Fixture = "ready" })
	if state := production.service.State(); state.Phase != PhaseIdle {
		t.Fatalf("production must ignore fixtures: %+v", state)
	}
}

func TestDownloadURLMustStayOnTheReleaseHostOverHTTPS(t *testing.T) {
	service := New(Config{CurrentVersion: "0.1.2"})
	for _, rawURL := range []string{
		"http://github.com/antonioducs/ducs-table/releases/download/v0.2.0/a.zip",
		"https://evil.example/antonioducs/ducs-table/releases/download/v0.2.0/a.zip",
		"file:///tmp/a.zip",
	} {
		if err := service.validateDownloadURL(rawURL); err == nil {
			t.Errorf("validateDownloadURL(%q) succeeded", rawURL)
		}
	}
	if err := service.validateDownloadURL("https://github.com/antonioducs/ducs-table/releases/download/v0.2.0/a.zip"); err != nil {
		t.Fatal(err)
	}
	if !service.releasePageAllowed("https://github.com/antonioducs/ducs-table/releases/tag/v0.2.0") ||
		service.releasePageAllowed("https://github.com/someone/else/releases/tag/v0.2.0") ||
		service.releasePageAllowed("javascript:alert(1)") {
		t.Fatal("release page allowlist is wrong")
	}
}

func TestDesignatedRequirementIsValidCodesignSyntax(t *testing.T) {
	if goruntime.GOOS != "darwin" {
		t.Skip("codesign is only available on macOS")
	}
	requirement := designatedRequirement(Identity{Identifier: testBundleID, TeamID: "TEAM123456"})
	output, err := exec.Command("/usr/bin/codesign", "--verify", "-R", "="+requirement, "/bin/ls").CombinedOutput()
	var exitErr *exec.ExitError
	// Exit 3 means the requirement parsed and /bin/ls (Apple-signed) did not
	// satisfy it; exit 1 would be a syntax error.
	if !errors.As(err, &exitErr) || exitErr.ExitCode() != 3 {
		t.Fatalf("codesign result = %v: %s", err, output)
	}
}

func phasesToStrings(phases []Phase) []string {
	result := make([]string, len(phases))
	for index, phase := range phases {
		result[index] = string(phase)
	}
	return result
}
