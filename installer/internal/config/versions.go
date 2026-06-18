package config

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/Masterminds/semver/v3"
)

const (
	githubReleasesURL = "https://api.github.com/repos/engrammic-ai/veil/releases"
	apiTimeout        = 15 * time.Second
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

// githubRelease is the GitHub API response shape we care about.
type githubRelease struct {
	TagName    string `json:"tag_name"`
	Prerelease bool   `json:"prerelease"`
	Draft      bool   `json:"draft"`
	Assets     []struct {
		Name               string `json:"name"`
		BrowserDownloadURL string `json:"browser_download_url"`
	} `json:"assets"`
}

// VersionCache is satisfied by download.Cache for version caching.
type VersionCache interface {
	GetVersions() (json.RawMessage, bool)
	PutVersions(json.RawMessage) error
}

// FetchReleases returns all releases for the given channel.
// Results are cached for 1 hour via cache.
func FetchReleases(cache VersionCache, channel Channel) ([]Release, error) {
	if raw, ok := cache.GetVersions(); ok {
		var all []Release
		if err := json.Unmarshal(raw, &all); err == nil {
			return filterByChannel(all, channel), nil
		}
	}

	releases, err := fetchFromGitHub()
	if err != nil {
		return nil, err
	}

	all := toReleases(releases)

	raw, err := json.Marshal(all)
	if err == nil {
		_ = cache.PutVersions(raw)
	}

	return filterByChannel(all, channel), nil
}

// GetLatest returns the newest release for the given channel.
func GetLatest(cache VersionCache, channel Channel) (*Release, error) {
	releases, err := FetchReleases(cache, channel)
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

func fetchFromGitHub() ([]githubRelease, error) {
	client := &http.Client{Timeout: apiTimeout}
	req, err := http.NewRequest(http.MethodGet, githubReleasesURL, nil)
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Accept", "application/vnd.github+json")

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch releases: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GitHub API returned %s", resp.Status)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read response: %w", err)
	}

	var releases []githubRelease
	if err := json.Unmarshal(body, &releases); err != nil {
		return nil, fmt.Errorf("parse releases: %w", err)
	}
	return releases, nil
}

// toReleases converts GitHub API responses to Release structs.
func toReleases(gr []githubRelease) []Release {
	var out []Release
	for _, r := range gr {
		if r.Draft {
			continue
		}
		ch := classifyChannel(r.TagName, r.Prerelease)
		rel := Release{
			Version: strings.TrimPrefix(r.TagName, "v"),
			Channel: ch,
			Assets:  make(map[string]string),
		}
		for _, a := range r.Assets {
			if strings.HasSuffix(a.Name, ".sha256") || strings.Contains(a.Name, "checksums") {
				continue
			}
			// Map asset name to platform key
			// Archives: "veil-linux-x64.tar.gz" -> "linux-x64"
			//           "veil-windows-x64.zip" -> "windows-x64"
			name := a.Name
			name = strings.TrimPrefix(name, "veil-")
			name = strings.TrimSuffix(name, ".tar.gz")
			name = strings.TrimSuffix(name, ".zip")
			name = strings.TrimSuffix(name, ".exe")
			rel.Assets[name] = a.BrowserDownloadURL
		}
		out = append(out, rel)
	}
	return out
}

// classifyChannel maps a tag name and prerelease flag to a Channel.
func classifyChannel(tag string, prerelease bool) Channel {
	tag = strings.ToLower(tag)
	if strings.Contains(tag, "nightly") || strings.Contains(tag, "dev") {
		return ChannelNightly
	}
	if prerelease || strings.Contains(tag, "rc") || strings.Contains(tag, "beta") || strings.Contains(tag, "alpha") {
		return ChannelBeta
	}
	return ChannelStable
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
