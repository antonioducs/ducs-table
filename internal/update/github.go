package update

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	maxReleaseJSONBytes = 2 << 20
	maxChecksumBytes    = 4 << 10
)

var errNoPublishedRelease = errors.New("no published release")

type release struct {
	TagName     string         `json:"tag_name"`
	HTMLURL     string         `json:"html_url"`
	Draft       bool           `json:"draft"`
	Prerelease  bool           `json:"prerelease"`
	PublishedAt time.Time      `json:"published_at"`
	Assets      []releaseAsset `json:"assets"`
}

type releaseAsset struct {
	Name   string `json:"name"`
	Size   int64  `json:"size"`
	URL    string `json:"browser_download_url"`
	Digest string `json:"digest"`
	State  string `json:"state"`
}

func (s *Service) fetchLatestRelease(ctx context.Context) (release, error) {
	ctx, cancel := context.WithTimeout(ctx, s.cfg.CheckTimeout)
	defer cancel()
	endpoint := fmt.Sprintf("%s/repos/%s/%s/releases/latest", strings.TrimRight(s.cfg.APIBaseURL, "/"), url.PathEscape(s.cfg.Owner), url.PathEscape(s.cfg.Repo))
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return release{}, err
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	request.Header.Set("User-Agent", s.userAgent())
	response, err := s.client.Do(request)
	if err != nil {
		return release{}, fmt.Errorf("contact GitHub: %w", err)
	}
	defer response.Body.Close()
	switch {
	case response.StatusCode == http.StatusNotFound:
		return release{}, errNoPublishedRelease
	case response.StatusCode == http.StatusForbidden || response.StatusCode == http.StatusTooManyRequests:
		return release{}, errors.New("GitHub rate limit reached; try again later")
	case response.StatusCode != http.StatusOK:
		return release{}, fmt.Errorf("GitHub returned HTTP %d", response.StatusCode)
	}
	var latest release
	if err := json.NewDecoder(io.LimitReader(response.Body, maxReleaseJSONBytes)).Decode(&latest); err != nil {
		return release{}, fmt.Errorf("read GitHub release: %w", err)
	}
	return latest, nil
}

// assetFor returns the ZIP package published for this architecture, named
// DucsTable-<version>-macOS-<ARCH>.zip by the release workflow.
func assetFor(latest release, version, goarch string) (releaseAsset, bool) {
	arch := map[string]string{"arm64": "ARM64", "amd64": "X64"}[goarch]
	if arch == "" {
		return releaseAsset{}, false
	}
	want := fmt.Sprintf("DucsTable-%s-macOS-%s.zip", version, arch)
	for _, asset := range latest.Assets {
		if strings.EqualFold(asset.Name, want) && (asset.State == "" || asset.State == "uploaded") && asset.URL != "" && asset.Size > 0 {
			return asset, true
		}
	}
	return releaseAsset{}, false
}

// expectedDigest prefers the SHA-256 digest GitHub computes for each asset and
// falls back to the <asset>.sha256 file published by the release workflow.
func (s *Service) expectedDigest(ctx context.Context, latest release, asset releaseAsset) (string, error) {
	if digest, ok := strings.CutPrefix(asset.Digest, "sha256:"); ok {
		return normalizeDigest(digest)
	}
	for _, candidate := range latest.Assets {
		if !strings.EqualFold(candidate.Name, asset.Name+".sha256") {
			continue
		}
		body, err := s.fetchSmall(ctx, candidate.URL, maxChecksumBytes)
		if err != nil {
			return "", fmt.Errorf("download checksum: %w", err)
		}
		fields := strings.Fields(string(body))
		if len(fields) == 0 {
			return "", errors.New("the published checksum file is empty")
		}
		return normalizeDigest(fields[0])
	}
	return "", errors.New("the release does not publish a SHA-256 checksum for this package")
}

func normalizeDigest(value string) (string, error) {
	value = strings.ToLower(strings.TrimSpace(value))
	decoded, err := hex.DecodeString(value)
	if err != nil || len(decoded) != 32 {
		return "", errors.New("the published SHA-256 checksum is malformed")
	}
	return value, nil
}

func (s *Service) fetchSmall(ctx context.Context, rawURL string, limit int64) ([]byte, error) {
	if err := s.validateDownloadURL(rawURL); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, s.cfg.CheckTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("User-Agent", s.userAgent())
	response, err := s.client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d", response.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > limit {
		return nil, errors.New("response is larger than expected")
	}
	return body, nil
}

// validateDownloadURL pins the initial request to the configured release
// host. Redirects (to GitHub's asset CDN) are only required to stay on HTTPS;
// integrity comes from the checksum and code-signature checks, not the host.
func (s *Service) validateDownloadURL(rawURL string) error {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return fmt.Errorf("invalid download URL: %w", err)
	}
	if parsed.Scheme != "https" && !(s.cfg.AllowInsecureHTTP && parsed.Scheme == "http") {
		return errors.New("update downloads must use HTTPS")
	}
	if !strings.EqualFold(parsed.Hostname(), s.cfg.DownloadHost) {
		return fmt.Errorf("unexpected download host %q", parsed.Hostname())
	}
	return nil
}

func (s *Service) releasePageAllowed(rawURL string) bool {
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Scheme != "https" || !strings.EqualFold(parsed.Hostname(), "github.com") {
		return false
	}
	prefix := fmt.Sprintf("/%s/%s/releases/", s.cfg.Owner, s.cfg.Repo)
	return strings.HasPrefix(strings.ToLower(parsed.Path), strings.ToLower(prefix))
}

func newHTTPClient(allowInsecure bool) *http.Client {
	return &http.Client{
		CheckRedirect: func(request *http.Request, via []*http.Request) error {
			if len(via) >= 10 {
				return errors.New("too many redirects")
			}
			if request.URL.Scheme != "https" && !(allowInsecure && request.URL.Scheme == "http") {
				return errors.New("update redirect left HTTPS")
			}
			return nil
		},
	}
}
