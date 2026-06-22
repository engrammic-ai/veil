package config

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/Masterminds/semver/v3"
)

const (
	releasesURL = "https://storage.googleapis.com/veil-releases/releases.json"
	apiTimeout  = 15 * time.Second
)

// Channel represents a release channel.
type Channel string

const (
	ChannelStable  Channel = "stable"
	ChannelBeta    Channel = "beta"
	ChannelNightly Channel = "nightly"
)

// Release represents a single downloadable release.
type Release struct {
	Version  string            `json:"version"`
	Channel  Channel           `json:"channel"`
	URL      string            `json:"url"`      // Deprecated: use Assets
	Checksum string            `json:"checksum"` // Deprecated: use Assets
	Assets   map[string]string `json:"assets"`   // platform -> download URL
}

// InstallerRelease represents the installer binary release info.
type InstallerRelease struct {
	Version string            `json:"version"`
	Assets  map[string]string `json:"assets"` // platform -> download URL
}

// releasesManifest is the GCS releases.json shape.
type releasesManifest struct {
	Releases  []Release         `json:"releases"`
	Installer *InstallerRelease `json:"installer,omitempty"`
}

// VersionCache is satisfied by download.Cache for version caching.
type VersionCache interface {
	GetVersions() (json.RawMessage, bool)
	PutVersions(json.RawMessage) error
}

// FetchReleases returns all releases for the given channel.
// Results are cached for 1 hour via cache.
func FetchReleases(cache VersionCache, channel Channel) ([]Release, error) {
	return fetchReleasesInternal(cache, channel, false)
}

// FetchReleasesRefresh fetches releases from GCS, bypassing cache.
// Use for commands like `releases` and `update` where fresh data is expected.
func FetchReleasesRefresh(cache VersionCache, channel Channel) ([]Release, error) {
	return fetchReleasesInternal(cache, channel, true)
}

func fetchReleasesInternal(cache VersionCache, channel Channel, refresh bool) ([]Release, error) {
	if !refresh {
		if raw, ok := cache.GetVersions(); ok {
			var all []Release
			if err := json.Unmarshal(raw, &all); err == nil {
				return filterByChannel(all, channel), nil
			}
		}
	}

	all, err := fetchFromGCS()
	if err != nil {
		return nil, err
	}

	raw, err := json.Marshal(all)
	if err == nil {
		_ = cache.PutVersions(raw)
	}

	return filterByChannel(all, channel), nil
}

// GetLatest returns the newest release for the given channel (uses cache).
func GetLatest(cache VersionCache, channel Channel) (*Release, error) {
	return getLatestInternal(cache, channel, false)
}

// GetLatestRefresh returns the newest release, bypassing cache.
func GetLatestRefresh(cache VersionCache, channel Channel) (*Release, error) {
	return getLatestInternal(cache, channel, true)
}

func getLatestInternal(cache VersionCache, channel Channel, refresh bool) (*Release, error) {
	var releases []Release
	var err error
	if refresh {
		releases, err = FetchReleasesRefresh(cache, channel)
	} else {
		releases, err = FetchReleases(cache, channel)
	}
	if err != nil {
		return nil, err
	}
	if len(releases) == 0 {
		return nil, fmt.Errorf("no releases found for channel %q", channel)
	}

	latest := &releases[0]
	for i := 1; i < len(releases); i++ {
		if CompareVersions(releases[i].Version, latest.Version) > 0 {
			latest = &releases[i]
		}
	}
	return latest, nil
}

// CompareVersions compares two semver strings.
// Returns -1 if a < b, 0 if a == b, 1 if a > b.
// Non-parseable versions sort before valid ones.
func CompareVersions(a, b string) int {
	va, errA := semver.NewVersion(a)
	vb, errB := semver.NewVersion(b)

	switch {
	case errA != nil && errB != nil:
		return 0
	case errA != nil:
		return -1
	case errB != nil:
		return 1
	}

	return va.Compare(vb)
}

func fetchFromGCS() ([]Release, error) {
	manifest, err := fetchManifestFromGCS()
	if err != nil {
		return nil, err
	}
	return manifest.Releases, nil
}

func fetchManifestFromGCS() (*releasesManifest, error) {
	client := &http.Client{Timeout: apiTimeout}
	resp, err := client.Get(releasesURL)
	if err != nil {
		return nil, fmt.Errorf("fetch releases: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("fetch releases: %s", resp.Status)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read response: %w", err)
	}

	var manifest releasesManifest
	if err := json.Unmarshal(body, &manifest); err != nil {
		return nil, fmt.Errorf("parse releases: %w", err)
	}
	return &manifest, nil
}

// GetInstallerRelease fetches the latest installer release info.
func GetInstallerRelease() (*InstallerRelease, error) {
	manifest, err := fetchManifestFromGCS()
	if err != nil {
		return nil, err
	}
	return manifest.Installer, nil
}

// GetAssetURL returns the download URL for a specific platform.
func (r *InstallerRelease) GetAssetURL(platform string) (string, bool) {
	if r == nil || r.Assets == nil {
		return "", false
	}
	url, ok := r.Assets[platform]
	return url, ok
}

// GetAssetURL returns the download URL for a specific platform.
// Platform should be like "linux-x64", "darwin-arm64", "windows-x64".
func (r *Release) GetAssetURL(platform string) (string, bool) {
	url, ok := r.Assets[platform]
	return url, ok
}

func filterByChannel(releases []Release, channel Channel) []Release {
	var out []Release
	for _, r := range releases {
		if r.Channel == channel {
			out = append(out, r)
		}
	}
	return out
}
