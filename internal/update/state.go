// Package update discovers, verifies, and installs new Duc's Table releases
// published on GitHub.
package update

// Phase is the lifecycle position of the most recent update check.
type Phase string

const (
	PhaseIdle        Phase = "idle"
	PhaseChecking    Phase = "checking"
	PhaseAvailable   Phase = "available"
	PhaseDownloading Phase = "downloading"
	PhaseVerifying   Phase = "verifying"
	PhaseReady       Phase = "ready"
	PhaseInstalling  Phase = "installing"
)

// Mode describes how far this particular installation can take an update.
type Mode string

const (
	// ModeOff disables all update network traffic (development builds).
	ModeOff Mode = "off"
	// ModeInstaller downloads, verifies, replaces the app bundle, and relaunches.
	ModeInstaller Mode = "installer"
	// ModeManual downloads and verifies, then reveals the new app in Finder
	// because the running bundle cannot be replaced in place.
	ModeManual Mode = "manual"
	// ModeNotify only links to the release page (unsigned builds or releases
	// without a package for this architecture).
	ModeNotify Mode = "notify"
)

// State is the complete update status mirrored to the frontend. Revision
// increases with every emitted change so the UI can discard binding
// responses that arrive after newer events.
type State struct {
	Revision         uint64  `json:"revision"`
	Phase            Phase   `json:"phase"`
	Mode             Mode    `json:"mode"`
	ModeReason       string  `json:"modeReason,omitempty"`
	CurrentVersion   string  `json:"currentVersion"`
	AvailableVersion string  `json:"availableVersion,omitempty"`
	ReleaseURL       string  `json:"releaseUrl,omitempty"`
	PublishedAt      string  `json:"publishedAt,omitempty"`
	DownloadedBytes  int64   `json:"downloadedBytes,omitempty"`
	TotalBytes       int64   `json:"totalBytes,omitempty"`
	Progress         float64 `json:"progress,omitempty"`
	LastCheckedAt    string  `json:"lastCheckedAt,omitempty"`
	AutoCheck        bool    `json:"autoCheck"`
	SkippedVersion   string  `json:"skippedVersion,omitempty"`
	Error            string  `json:"error,omitempty"`
}

func (s State) busy() bool {
	switch s.Phase {
	case PhaseChecking, PhaseDownloading, PhaseVerifying, PhaseInstalling:
		return true
	}
	return false
}
