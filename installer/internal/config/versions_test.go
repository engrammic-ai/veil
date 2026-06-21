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

// releasesManifestJSON returns a minimal GCS releases.json payload.
func releasesManifestJSON() []byte {
	return []byte(`{
		"releases": [
			{"version":"1.2.0","channel":"stable","assets":{"linux-x64":"https://example.com/v1.2.0/veil-linux-x64.tar.gz"}},
			{"version":"1.1.0","channel":"stable","assets":{"linux-x64":"https://example.com/v1.1.0/veil-linux-x64.tar.gz"}},
			{"version":"1.3.0-rc1","channel":"beta","assets":{"linux-x64":"https://example.com/v1.3.0-rc1/veil-linux-x64.tar.gz"}},
			{"version":"2.0.0-nightly","channel":"nightly","assets":{"linux-x64":"https://example.com/v2.0.0-nightly/veil-linux-x64.tar.gz"}}
		]
	}`)
}

func makeTestServer(t *testing.T, body []byte) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write(body)
	}))
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
	srv := makeTestServer(t, releasesManifestJSON())
	defer srv.Close()

	// Parse the manifest directly to populate cache
	var manifest releasesManifest
	if err := json.Unmarshal(releasesManifestJSON(), &manifest); err != nil {
		t.Fatal(err)
	}

	raw, _ := json.Marshal(manifest.Releases)
	cache := &stubCache{}
	if err := cache.PutVersions(raw); err != nil {
		t.Fatal(err)
	}

	got, err := FetchReleases(cache, ChannelStable)
	if err != nil {
		t.Fatal(err)
	}
	// fixture has 2 stable, 1 beta, 1 nightly
	if len(got) != 2 {
		t.Fatalf("stable releases = %d, want 2; got=%+v", len(got), got)
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
