package update

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

// Identity is the code-signing identity of an app bundle.
type Identity struct {
	Identifier string
	TeamID     string
}

// BundleInfo is the subset of Info.plist the updater validates.
type BundleInfo struct {
	Identifier string
	Version    string
}

// Tools wraps the macOS system utilities the updater depends on so the state
// machine can be tested without real signatures, archives, or processes.
type Tools interface {
	SigningIdentity(ctx context.Context, bundle string) (Identity, error)
	BundleInfo(ctx context.Context, bundle string) (BundleInfo, error)
	VerifySignature(ctx context.Context, bundle, requirement string) error
	AssessGatekeeper(ctx context.Context, bundle string) error
	Extract(ctx context.Context, archive, destination string) error
	Copy(ctx context.Context, source, destination string) error
	Reveal(bundle string) error
	Relaunch(pid int, bundle string) error
}

// designatedRequirement accepts only a Developer ID Application signature from
// the same team and bundle identifier as the running app.
func designatedRequirement(identity Identity) string {
	return fmt.Sprintf(
		`anchor apple generic and identifier %s and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = %s`,
		strconv.Quote(identity.Identifier), strconv.Quote(identity.TeamID),
	)
}

// SystemTools uses the utilities shipped with every macOS installation; none
// require the Xcode Command Line Tools.
type SystemTools struct{}

func (SystemTools) SigningIdentity(ctx context.Context, bundle string) (Identity, error) {
	// codesign -d writes its report to stderr.
	output, err := run(ctx, "/usr/bin/codesign", "-dv", "--verbose=2", bundle)
	if err != nil {
		return Identity{}, err
	}
	var identity Identity
	for _, line := range strings.Split(output, "\n") {
		key, value, ok := strings.Cut(strings.TrimSpace(line), "=")
		if !ok {
			continue
		}
		switch key {
		case "Identifier":
			identity.Identifier = value
		case "TeamIdentifier":
			if value != "not set" {
				identity.TeamID = value
			}
		}
	}
	return identity, nil
}

func (SystemTools) BundleInfo(ctx context.Context, bundle string) (BundleInfo, error) {
	command := exec.CommandContext(ctx, "/usr/bin/plutil", "-convert", "json", "-o", "-", filepath.Join(bundle, "Contents", "Info.plist"))
	var stdout, stderr bytes.Buffer
	command.Stdout, command.Stderr = &stdout, &stderr
	if err := command.Run(); err != nil {
		return BundleInfo{}, commandError("plutil", err, stderr.String())
	}
	var plist struct {
		Identifier string `json:"CFBundleIdentifier"`
		Version    string `json:"CFBundleShortVersionString"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &plist); err != nil {
		return BundleInfo{}, fmt.Errorf("parse Info.plist: %w", err)
	}
	return BundleInfo{Identifier: plist.Identifier, Version: plist.Version}, nil
}

func (SystemTools) VerifySignature(ctx context.Context, bundle, requirement string) error {
	_, err := run(ctx, "/usr/bin/codesign", "--verify", "--deep", "--strict", "-R", "="+requirement, bundle)
	return err
}

func (SystemTools) AssessGatekeeper(ctx context.Context, bundle string) error {
	_, err := run(ctx, "/usr/sbin/spctl", "--assess", "--type", "execute", bundle)
	return err
}

func (SystemTools) Extract(ctx context.Context, archive, destination string) error {
	// ditto preserves the symlinks, extended attributes, and resource forks
	// that a signed app bundle depends on; archive/zip does not.
	_, err := run(ctx, "/usr/bin/ditto", "-x", "-k", archive, destination)
	return err
}

func (SystemTools) Copy(ctx context.Context, source, destination string) error {
	_, err := run(ctx, "/usr/bin/ditto", source, destination)
	return err
}

func (SystemTools) Reveal(bundle string) error {
	_, err := run(context.Background(), "/usr/bin/open", "-R", bundle)
	return err
}

// relaunchScript waits for the old process to exit (at most 60 seconds) and
// opens the replaced bundle. Paths are positional arguments, never
// interpolated, because the app name contains an apostrophe.
const relaunchScript = `pid="$1"; app="$2"; tries=0
while kill -0 "$pid" 2>/dev/null; do
  tries=$((tries + 1))
  if [ "$tries" -gt 600 ]; then exit 1; fi
  sleep 0.1
done
exec /usr/bin/open "$app"`

func (SystemTools) Relaunch(pid int, bundle string) error {
	command := exec.Command("/bin/sh", "-c", relaunchScript, "ducs-table-relaunch", strconv.Itoa(pid), bundle)
	command.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := command.Start(); err != nil {
		return fmt.Errorf("start relaunch helper: %w", err)
	}
	return command.Process.Release()
}

func run(ctx context.Context, name string, args ...string) (string, error) {
	command := exec.CommandContext(ctx, name, args...)
	var output bytes.Buffer
	command.Stdout, command.Stderr = &output, &output
	if err := command.Run(); err != nil {
		return output.String(), commandError(filepath.Base(name), err, output.String())
	}
	return output.String(), nil
}

func commandError(name string, err error, output string) error {
	output = strings.TrimSpace(output)
	if len(output) > 512 {
		output = output[:512] + "…"
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) && output != "" {
		return fmt.Errorf("%s failed (exit %d): %s", name, exitErr.ExitCode(), output)
	}
	return fmt.Errorf("%s failed: %w", name, err)
}
