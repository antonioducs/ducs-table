package update

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

const (
	appDirectory   = "app"
	verifiedMarker = ".verified"
	archiveName    = "update.zip"
	incomingSuffix = ".update-incoming"
	previousSuffix = ".update-previous"
)

// bundlePath returns the .app that contains executable
// (<bundle>.app/Contents/MacOS/<binary>).
func bundlePath(executable string) (string, bool) {
	if executable == "" {
		return "", false
	}
	if resolved, err := filepath.EvalSymlinks(executable); err == nil {
		executable = resolved
	}
	macOS := filepath.Dir(executable)
	contents := filepath.Dir(macOS)
	bundle := filepath.Dir(contents)
	if filepath.Base(macOS) != "MacOS" || filepath.Base(contents) != "Contents" || !strings.HasSuffix(bundle, ".app") {
		return "", false
	}
	return bundle, true
}

// translocated reports Gatekeeper App Translocation, which runs quarantined
// apps from a randomized read-only mount instead of their real location.
func translocated(bundle string) bool {
	return strings.Contains(bundle, "/AppTranslocation/")
}

func probeWritable(dir string) error {
	probe, err := os.CreateTemp(dir, ".ducs-update-probe-*")
	if err != nil {
		return err
	}
	name := probe.Name()
	_ = probe.Close()
	return os.Remove(name)
}

func siblingPath(target, suffix string) string {
	return filepath.Join(filepath.Dir(target), "."+filepath.Base(target)+suffix)
}

// replaceBundle swaps the running bundle for the verified update with two
// renames in the same directory, rolling back if the second one fails. macOS
// keeps the running process valid because its files remain open by inode.
func (s *Service) replaceBundle(ctx context.Context, app, target string) error {
	if translocated(target) {
		return fmt.Errorf("the app is running from a translocated location: %w", fs.ErrPermission)
	}
	parent := filepath.Dir(target)
	if err := probeWritable(parent); err != nil {
		return fmt.Errorf("the app folder is not writable: %w", err)
	}
	incoming, previous := siblingPath(target, incomingSuffix), siblingPath(target, previousSuffix)
	_ = os.RemoveAll(incoming)
	_ = os.RemoveAll(previous)

	restoreStaged := func() {}
	switch err := os.Rename(app, incoming); {
	case err == nil:
		restoreStaged = func() { _ = os.Rename(incoming, app) }
	case errors.Is(err, syscall.EXDEV):
		if err := s.tools.Copy(ctx, app, incoming); err != nil {
			_ = os.RemoveAll(incoming)
			return fmt.Errorf("copy the update next to the app: %w", err)
		}
		restoreStaged = func() { _ = os.RemoveAll(incoming) }
	default:
		return fmt.Errorf("stage the update next to the app: %w", err)
	}
	// The staged copy is checked again at its final volume before anything
	// the user is running is moved.
	if err := s.tools.VerifySignature(ctx, incoming, designatedRequirement(s.identity)); err != nil {
		restoreStaged()
		return fmt.Errorf("code signature rejected: %w", err)
	}
	if err := os.Rename(target, previous); err != nil {
		restoreStaged()
		return fmt.Errorf("move the current app aside: %w", err)
	}
	if err := os.Rename(incoming, target); err != nil {
		if rollbackErr := os.Rename(previous, target); rollbackErr != nil {
			return errors.Join(fmt.Errorf("move the update into place: %w", err), fmt.Errorf("restore the previous app: %w", rollbackErr))
		}
		restoreStaged()
		return fmt.Errorf("move the update into place: %w", err)
	}
	return nil
}

// removeLeftovers deletes the previous bundle kept by the last install (only
// once the new version is running) and stale downloads.
func (s *Service) removeLeftovers() {
	if s.bundle != "" {
		for _, path := range []string{siblingPath(s.bundle, previousSuffix), siblingPath(s.bundle, incomingSuffix)} {
			if _, err := os.Lstat(path); err != nil {
				continue
			}
			if err := os.RemoveAll(path); err != nil {
				s.log.Error("update_leftover_cleanup_failed", err, nil)
				continue
			}
			s.log.Info("update_leftover_removed", "kind", strings.TrimPrefix(filepath.Ext(path), "."))
		}
	}
	current, err := ParseVersion(s.cfg.CurrentVersion)
	if err != nil || s.cfg.CacheDir == "" {
		return
	}
	entries, err := os.ReadDir(s.cfg.CacheDir)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if version, err := ParseVersion(entry.Name()); err == nil && entry.IsDir() && version.Compare(current) > 0 {
			continue
		}
		if err := os.RemoveAll(filepath.Join(s.cfg.CacheDir, entry.Name())); err != nil {
			s.log.Error("update_cache_cleanup_failed", err, nil)
		}
	}
}

func hasCachedApp(dir string) bool {
	if _, err := os.Stat(filepath.Join(dir, verifiedMarker)); err != nil {
		return false
	}
	_, err := findApp(filepath.Join(dir, appDirectory))
	return err == nil
}

func (s *Service) prepareUpdate(ctx context.Context, dir, version string, latest release, asset releaseAsset) (string, error) {
	if hasCachedApp(dir) {
		s.setPhase(PhaseVerifying)
		app, err := findApp(filepath.Join(dir, appDirectory))
		if err == nil {
			if err = s.verifyApp(ctx, app, version); err == nil {
				return app, nil
			}
		}
		s.log.Error("update_cache_rejected", err, nil, "version", version)
		s.setPhase(PhaseDownloading)
	}
	if asset.Size > s.cfg.MaxDownloadBytes {
		return "", fmt.Errorf("the package is %d bytes, above the %d byte limit", asset.Size, s.cfg.MaxDownloadBytes)
	}
	digest, err := s.expectedDigest(ctx, latest, asset)
	if err != nil {
		return "", err
	}
	if err := os.RemoveAll(dir); err != nil {
		return "", err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	archive, err := s.downloadAsset(ctx, dir, asset, digest)
	if err != nil {
		return "", err
	}
	s.setPhase(PhaseVerifying)
	destination := filepath.Join(dir, appDirectory)
	if err := os.MkdirAll(destination, 0o700); err != nil {
		return "", err
	}
	if err := s.tools.Extract(ctx, archive, destination); err != nil {
		return "", fmt.Errorf("extract the package: %w", err)
	}
	_ = os.Remove(archive)
	app, err := findApp(destination)
	if err != nil {
		return "", err
	}
	if err := s.verifyApp(ctx, app, version); err != nil {
		return "", err
	}
	if err := os.WriteFile(filepath.Join(dir, verifiedMarker), []byte(digest+"\n"), 0o600); err != nil {
		return "", err
	}
	return app, nil
}

func (s *Service) downloadAsset(ctx context.Context, dir string, asset releaseAsset, digest string) (string, error) {
	if err := s.validateDownloadURL(asset.URL); err != nil {
		return "", err
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	stall := time.AfterFunc(s.cfg.StallTimeout, cancel)
	defer stall.Stop()

	request, err := http.NewRequestWithContext(ctx, http.MethodGet, asset.URL, nil)
	if err != nil {
		return "", err
	}
	request.Header.Set("Accept", "application/octet-stream")
	request.Header.Set("User-Agent", s.userAgent())
	response, err := s.client.Do(request)
	if err != nil {
		return "", fmt.Errorf("download the package: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", fmt.Errorf("download the package: HTTP %d", response.StatusCode)
	}

	partial := filepath.Join(dir, archiveName+".partial")
	file, err := os.OpenFile(partial, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return "", err
	}
	defer os.Remove(partial)
	hash := sha256.New()
	buffer := make([]byte, 256<<10)
	var written int64
	body := io.LimitReader(response.Body, asset.Size+1)
	for {
		count, readErr := body.Read(buffer)
		if count > 0 {
			stall.Reset(s.cfg.StallTimeout)
			if written += int64(count); written > asset.Size {
				_ = file.Close()
				return "", errors.New("the package is larger than GitHub reported")
			}
			if _, err := file.Write(buffer[:count]); err != nil {
				_ = file.Close()
				return "", err
			}
			hash.Write(buffer[:count])
			s.reportProgress(written, asset.Size)
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			_ = file.Close()
			return "", fmt.Errorf("download the package: %w", readErr)
		}
	}
	if err := file.Close(); err != nil {
		return "", err
	}
	if written != asset.Size {
		return "", fmt.Errorf("the download is incomplete (%d of %d bytes)", written, asset.Size)
	}
	if got := hex.EncodeToString(hash.Sum(nil)); got != digest {
		return "", errors.New("the package does not match its published SHA-256 checksum")
	}
	archive := filepath.Join(dir, archiveName)
	if err := os.Rename(partial, archive); err != nil {
		return "", err
	}
	return archive, nil
}

// findApp requires the archive to contain exactly one real app directory.
func findApp(dir string) (string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return "", err
	}
	var app string
	for _, entry := range entries {
		if entry.Name() == "__MACOSX" {
			continue
		}
		if !strings.HasSuffix(entry.Name(), ".app") || entry.Type()&fs.ModeSymlink != 0 || !entry.IsDir() || app != "" {
			return "", errors.New("the package must contain exactly one app bundle")
		}
		app = filepath.Join(dir, entry.Name())
	}
	if app == "" {
		return "", errors.New("the package does not contain an app bundle")
	}
	return app, nil
}

func (s *Service) verifyApp(ctx context.Context, app, version string) error {
	info, err := s.tools.BundleInfo(ctx, app)
	if err != nil {
		return fmt.Errorf("read the update's Info.plist: %w", err)
	}
	if info.Identifier != s.identity.Identifier {
		return fmt.Errorf("the update has bundle identifier %q; expected %q", info.Identifier, s.identity.Identifier)
	}
	if info.Version != version {
		return fmt.Errorf("the update reports version %q; expected %q", info.Version, version)
	}
	if err := s.tools.VerifySignature(ctx, app, designatedRequirement(s.identity)); err != nil {
		return fmt.Errorf("code signature rejected: %w", err)
	}
	if err := s.tools.AssessGatekeeper(ctx, app); err != nil {
		return fmt.Errorf("Gatekeeper rejected the update: %w", err)
	}
	return nil
}
