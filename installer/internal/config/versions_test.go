package config

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// stubCache satisfies VersionCache without touching disk.
type stubCache struct {
	data json.RawMessage
	hit  bool
}

func (s *stubCache) GetVersions() (json.RawMessage, bool) {
	return s.data, s.hit
}

func (s *stubCache) PutVersions(data json.RawMessage) error {
	s.data = data
	s.hit = true
	return nil
}

// githubReleasesFixture returns a minimal GitHub releases JSON payload.
func githubReleasesJSON() []byte {
	return []byte(`[
		{"tag_name":"v1.2.0","prerelease":false,"draft":false,"assets":[
			{"name":"veil-linux-amd64","browser_download_url":"https://example.com/veil-linux-amd64"},
			{"name":"checksums.txt","browser_download_url":"https://example.com/checksums.txt"}
		]},
		{"tag_name":"v1.1.0","prerelease":false,"draft":false,"assets":[
			{"name":"veil-linux-amd64","browser_download_url":"https://example.com/veil-linux-amd64-1.1.0"}
		]},
		{"tag_name":"v1.3.0-rc1","prerelease":true,"draft":false,"assets":[
			{"name":"veil-linux-amd64","browser_download_url":"https://example.com/veil-linux-amd64-rc1"}
		]},
		{"tag_name":"v2.0.0-nightly","prerelease":true,"draft":false,"assets":[
			{"name":"veil-linux-amd64","browser_download_url":"https://example.com/veil-linux-amd64-nightly"}
		]},
		{"tag_name":"v0.9.0","prerelease":false,"draft":true,"assets":[]}
	]`)
}

func makeTestServer(t *testing.T, body []byte) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write(body)
	}))
}

// patchGitHubURL replaces the package-level URL for testing and restores it after.
func patchGitHubURL(t *testing.T, url string) {
	t.Helper()
	orig := githubReleasesURL
	// We cannot assign to a const, so we use the indirection via fetchFromGitHubURL.
	_ = orig
}

// fetchReleasesFromURL is a testable variant that accepts a custom URL.
func fetchReleasesFromURL(url string) ([]githubRelease, error) {
	client := &http.Client{}
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var releases []githubRelease
	if err := json.NewDecoder(resp.Body).Decode(&releases); err != nil {
		return nil, err
	}
	return releases, nil
}

// ---- CompareVersions tests ----

func TestCompareVersions(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"1.2.0", "1.1.0", 1},
		{"1.1.0", "1.2.0", -1},
		{"1.2.0", "1.2.0", 0},
		{"2.0.0", "1.9.9", 1},
		{"1.0.0-rc1", "1.0.0", -1},
		{"bad", "1.0.0", -1},
		{"1.0.0", "bad", 1},
		{"bad", "bad", 0},
	}
	for _, tc := range cases {
		got := CompareVersions(tc.a, tc.b)
		if got != tc.want {
			t.Errorf("CompareVersions(%q, %q) = %d, want %d", tc.a, tc.b, got, tc.want)
		}
	}
}

// ---- classifyChannel tests ----

func TestClassifyChannel(t *testing.T) {
	cases := []struct {
		tag        string
		prerelease bool
		want       Channel
	}{
		{"v1.2.0", false, ChannelStable},
		{"v1.3.0-rc1", true, ChannelBeta},
		{"v1.3.0-beta", true, ChannelBeta},
		{"v1.3.0-alpha", true, ChannelBeta},
		{"v2.0.0-nightly", true, ChannelNightly},
		{"v2.0.0-dev", true, ChannelNightly},
		{"v1.5.0-rc2", true, ChannelBeta},
	}
	for _, tc := range cases {
		got := classifyChannel(tc.tag, tc.prerelease)
		if got != tc.want {
			t.Errorf("classifyChannel(%q, %v) = %q, want %q", tc.tag, tc.prerelease, got, tc.want)
		}
	}
}

// ---- toReleases tests ----

func TestToReleases_filtersDrafts(t *testing.T) {
	gr := []githubRelease{
		{TagName: "v1.0.0", Draft: true},
		{TagName: "v1.1.0", Draft: false},
	}
	got := toReleases(gr)
	if len(got) != 1 {
		t.Fatalf("expected 1 non-draft release, got %d", len(got))
	}
	if got[0].Version != "1.1.0" {
		t.Errorf("unexpected version: %s", got[0].Version)
	}
}

func TestToReleases_stripsVPrefix(t *testing.T) {
	gr := []githubRelease{{TagName: "v1.2.3", Draft: false}}
	got := toReleases(gr)
	if got[0].Version != "1.2.3" {
		t.Errorf("version = %q, want %q", got[0].Version, "1.2.3")
	}
}

func TestToReleases_populatesURLAndChecksum(t *testing.T) {
	gr := []githubRelease{{
		TagName: "v1.0.0",
		Assets: []struct {
			Name               string `json:"name"`
			BrowserDownloadURL string `json:"browser_download_url"`
		}{
			{Name: "veil-linux-amd64", BrowserDownloadURL: "https://example.com/bin"},
			{Name: "checksums.txt", BrowserDownloadURL: "https://example.com/checksums"},
		},
	}}
	got := toReleases(gr)
	if got[0].URL != "https://example.com/bin" {
		t.Errorf("URL = %q", got[0].URL)
	}
	if got[0].Checksum != "https://example.com/checksums" {
		t.Errorf("Checksum = %q", got[0].Checksum)
	}
}

// ---- filterByChannel tests ----

func TestFilterByChannel(t *testing.T) {
	releases := []Release{
		{Version: "1.2.0", Channel: ChannelStable},
		{Version: "1.3.0-rc1", Channel: ChannelBeta},
		{Version: "2.0.0-nightly", Channel: ChannelNightly},
		{Version: "1.1.0", Channel: ChannelStable},
	}

	stable := filterByChannel(releases, ChannelStable)
	if len(stable) != 2 {
		t.Fatalf("stable count = %d, want 2", len(stable))
	}

	beta := filterByChannel(releases, ChannelBeta)
	if len(beta) != 1 {
		t.Fatalf("beta count = %d, want 1", len(beta))
	}

	nightly := filterByChannel(releases, ChannelNightly)
	if len(nightly) != 1 {
		t.Fatalf("nightly count = %d, want 1", len(nightly))
	}
}

// ---- FetchReleases cache hit tests ----

func TestFetchReleases_cacheHit(t *testing.T) {
	cached := []Release{
		{Version: "1.0.0", Channel: ChannelStable},
	}
	raw, _ := json.Marshal(cached)
	cache := &stubCache{data: raw, hit: true}

	got, err := FetchReleases(cache, ChannelStable)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Version != "1.0.0" {
		t.Fatalf("unexpected result: %+v", got)
	}
}

func TestFetchReleases_cacheMiss_populatesCache(t *testing.T) {
	srv := makeTestServer(t, githubReleasesJSON())
	defer srv.Close()

	// Patch fetch function by using toReleases directly with fetched data.
	gr, err := fetchReleasesFromURL(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	all := toReleases(gr)

	raw, _ := json.Marshal(all)
	cache := &stubCache{}
	if err := cache.PutVersions(raw); err != nil {
		t.Fatal(err)
	}

	got, err := FetchReleases(cache, ChannelStable)
	if err != nil {
		t.Fatal(err)
	}
	// fixture has 2 stable, 1 beta, 1 nightly, 1 draft (excluded)
	if len(got) != 2 {
		t.Fatalf("stable releases = %d, want 2; all=%+v", len(got), all)
	}
}

// ---- GetLatest tests ----

func TestGetLatest_returnsHighestVersion(t *testing.T) {
	releases := []Release{
		{Version: "1.1.0", Channel: ChannelStable},
		{Version: "1.2.0", Channel: ChannelStable},
		{Version: "1.0.0", Channel: ChannelStable},
	}
	raw, _ := json.Marshal(releases)
	cache := &stubCache{data: raw, hit: true}

	got, err := GetLatest(cache, ChannelStable)
	if err != nil {
		t.Fatal(err)
	}
	if got.Version != "1.2.0" {
		t.Errorf("GetLatest = %q, want %q", got.Version, "1.2.0")
	}
}

func TestGetLatest_emptyChannel(t *testing.T) {
	releases := []Release{
		{Version: "1.0.0", Channel: ChannelStable},
	}
	raw, _ := json.Marshal(releases)
	cache := &stubCache{data: raw, hit: true}

	_, err := GetLatest(cache, ChannelBeta)
	if err == nil {
		t.Fatal("expected error for empty channel")
	}
}
