package telemetry

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// ---- UUID tests ----

func TestNewUUID_format(t *testing.T) {
	u := newUUID()
	// Expect xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx  (8-4-4-4-12 hex chars)
	parts := strings.Split(u, "-")
	if len(parts) != 5 {
		t.Fatalf("UUID has %d segments, want 5: %q", len(parts), u)
	}
	lengths := []int{8, 4, 4, 4, 12}
	for i, p := range parts {
		if len(p) != lengths[i] {
			t.Errorf("segment %d: len=%d, want %d", i, len(p), lengths[i])
		}
		for _, c := range p {
			if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
				t.Errorf("segment %d has non-hex char %q", i, c)
			}
		}
	}
}

func TestNewUUID_version4(t *testing.T) {
	u := newUUID()
	// Version nibble is at index 14 of the UUID string (after removing dashes: position 12).
	// In "xxxxxxxx-xxxx-4xxx-..." the '4' is at string index 14.
	if u[14] != '4' {
		t.Errorf("UUID version nibble = %q, want '4'", u[14])
	}
	// Variant nibble is at string index 19; must be 8, 9, a, or b.
	v := u[19]
	if v != '8' && v != '9' && v != 'a' && v != 'b' {
		t.Errorf("UUID variant nibble = %q, want 8/9/a/b", v)
	}
}

func TestNewUUID_unique(t *testing.T) {
	seen := make(map[string]struct{}, 100)
	for i := 0; i < 100; i++ {
		u := newUUID()
		if _, dup := seen[u]; dup {
			t.Fatalf("duplicate UUID after %d iterations: %q", i, u)
		}
		seen[u] = struct{}{}
	}
}

// ---- Config persistence tests ----

func configDir_forTest(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)
	return dir
}

func TestSaveAndLoadConfig_roundtrip(t *testing.T) {
	configDir_forTest(t)

	cfg := Config{Enabled: true, DeviceID: "test-device-id"}
	if err := SaveConfig(cfg); err != nil {
		t.Fatalf("SaveConfig: %v", err)
	}

	got, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if got.Enabled != cfg.Enabled {
		t.Errorf("Enabled: got %v, want %v", got.Enabled, cfg.Enabled)
	}
	if got.DeviceID != cfg.DeviceID {
		t.Errorf("DeviceID: got %q, want %q", got.DeviceID, cfg.DeviceID)
	}
}

func TestLoadConfig_missingFile_returnsDisabled(t *testing.T) {
	configDir_forTest(t)

	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.Enabled {
		t.Error("expected Enabled=false when config file is absent")
	}
	if cfg.DeviceID != "" {
		t.Errorf("expected empty DeviceID, got %q", cfg.DeviceID)
	}
}

func TestLoadConfig_corruptFile_returnsError(t *testing.T) {
	dir := configDir_forTest(t)
	p := filepath.Join(dir, configDir, configFile)
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(p, []byte("not-json!"), 0o600)

	_, err := LoadConfig()
	if err == nil {
		t.Error("expected error for corrupt config file")
	}
}

func TestSaveConfig_filePermissions(t *testing.T) {
	dir := configDir_forTest(t)

	if err := SaveConfig(Config{Enabled: false}); err != nil {
		t.Fatalf("SaveConfig: %v", err)
	}

	p := filepath.Join(dir, configDir, configFile)
	info, err := os.Stat(p)
	if err != nil {
		t.Fatalf("stat config file: %v", err)
	}
	// File must not be world-readable.
	if info.Mode()&0o077 != 0 {
		t.Errorf("config file mode %o is too permissive (want 0600)", info.Mode())
	}
}

func TestSaveConfig_validJSON(t *testing.T) {
	dir := configDir_forTest(t)

	cfg := Config{Enabled: true, DeviceID: newUUID()}
	if err := SaveConfig(cfg); err != nil {
		t.Fatal(err)
	}

	p := filepath.Join(dir, configDir, configFile)
	data, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	var parsed map[string]any
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatalf("saved config is not valid JSON: %v", err)
	}
}

// ---- Recorder tests ----

func TestRecorder_disabledByDefault(t *testing.T) {
	r := newWithConfig(Config{})
	if r.Enabled() {
		t.Error("recorder should be disabled by default")
	}
}

func TestRecorder_Enable_setsDeviceID(t *testing.T) {
	r := newWithConfig(Config{})
	r.Enable()
	if !r.Enabled() {
		t.Error("expected Enabled after Enable()")
	}
	if r.cfg.DeviceID == "" {
		t.Error("expected DeviceID to be generated on Enable()")
	}
}

func TestRecorder_Enable_preservesExistingDeviceID(t *testing.T) {
	existing := "existing-id"
	r := newWithConfig(Config{DeviceID: existing})
	r.Enable()
	if r.cfg.DeviceID != existing {
		t.Errorf("DeviceID changed: got %q, want %q", r.cfg.DeviceID, existing)
	}
}

func TestRecorder_Disable(t *testing.T) {
	r := newWithConfig(Config{Enabled: true, DeviceID: newUUID()})
	r.Disable()
	if r.Enabled() {
		t.Error("expected disabled after Disable()")
	}
}

func TestRecorder_Record_disabled_noop(t *testing.T) {
	r := newWithConfig(Config{})
	r.Record(Event{Name: EventInstallStart})
	r.mu.Lock()
	n := len(r.queue)
	r.mu.Unlock()
	if n != 0 {
		t.Errorf("expected 0 queued events when disabled, got %d", n)
	}
}

func TestRecorder_Record_enabled_queues(t *testing.T) {
	r := newWithConfig(Config{Enabled: true, DeviceID: newUUID()})
	r.Record(Event{Name: EventInstallStart})
	r.Record(Event{Name: EventInstallComplete, Properties: map[string]any{"version": "1.2.3"}})

	r.mu.Lock()
	n := len(r.queue)
	r.mu.Unlock()
	if n != 2 {
		t.Errorf("expected 2 queued events, got %d", n)
	}
}

func TestRecorder_Record_setsTimestamp(t *testing.T) {
	r := newWithConfig(Config{Enabled: true, DeviceID: newUUID()})
	before := time.Now().UTC().Add(-time.Second)
	r.Record(Event{Name: EventInstallStart})
	after := time.Now().UTC().Add(time.Second)

	r.mu.Lock()
	ts := r.queue[0].Timestamp
	r.mu.Unlock()

	if ts.Before(before) || ts.After(after) {
		t.Errorf("timestamp %v outside expected range [%v, %v]", ts, before, after)
	}
}

func TestRecorder_Record_respectsProvidedTimestamp(t *testing.T) {
	r := newWithConfig(Config{Enabled: true, DeviceID: newUUID()})
	fixed := time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC)
	r.Record(Event{Name: EventInstallStart, Timestamp: fixed})

	r.mu.Lock()
	ts := r.queue[0].Timestamp
	r.mu.Unlock()

	if !ts.Equal(fixed) {
		t.Errorf("timestamp overwritten: got %v, want %v", ts, fixed)
	}
}

func TestRecorder_Record_boundsQueue(t *testing.T) {
	r := newWithConfig(Config{Enabled: true, DeviceID: newUUID()})
	for i := 0; i < maxQueuedEvents+10; i++ {
		r.Record(Event{Name: EventInstallStart})
	}
	r.mu.Lock()
	n := len(r.queue)
	r.mu.Unlock()
	if n > maxQueuedEvents {
		t.Errorf("queue length %d exceeds max %d", n, maxQueuedEvents)
	}
}

// ---- Flush / HTTP tests ----

func recorderWithServer(t *testing.T, srv *httptest.Server) *Recorder {
	t.Helper()
	r := newWithConfig(Config{Enabled: true, DeviceID: "test-device"})
	r.client = srv.Client()
	// Point telemetry at the test server by replacing the send method's URL
	// via a custom transport that rewrites the host.
	r.client.Transport = &rewriteTransport{base: srv.URL, inner: srv.Client().Transport}
	return r
}

// rewriteTransport replaces the scheme+host of every request with base.
type rewriteTransport struct {
	base  string
	inner http.RoundTripper
}

func (rt *rewriteTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	clone := req.Clone(req.Context())
	clone.URL.Scheme = "http"
	clone.URL.Host = strings.TrimPrefix(rt.base, "http://")
	if rt.inner != nil {
		return rt.inner.RoundTrip(clone)
	}
	return http.DefaultTransport.RoundTrip(clone)
}

func TestRecorder_Flush_disabled_noop(t *testing.T) {
	var called atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called.Store(true)
	}))
	defer srv.Close()

	r := newWithConfig(Config{}) // disabled
	r.client = srv.Client()
	r.Record(Event{Name: EventInstallStart})
	if err := r.Flush(); err != nil {
		t.Fatalf("Flush on disabled recorder: %v", err)
	}
	if called.Load() {
		t.Error("HTTP call made when telemetry is disabled")
	}
}

func TestRecorder_Flush_emptyQueue_noop(t *testing.T) {
	var called atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called.Store(true)
	}))
	defer srv.Close()

	r := recorderWithServer(t, srv)
	// No events recorded.
	if err := r.Flush(); err != nil {
		t.Fatalf("Flush on empty queue: %v", err)
	}
	if called.Load() {
		t.Error("HTTP call made for empty queue")
	}
}

func TestRecorder_Flush_sendsEvents(t *testing.T) {
	var received payload
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("method = %s, want POST", r.Method)
		}
		if ct := r.Header.Get("Content-Type"); ct != "application/json" {
			t.Errorf("Content-Type = %q, want application/json", ct)
		}
		if err := json.NewDecoder(r.Body).Decode(&received); err != nil {
			t.Errorf("decode payload: %v", err)
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	r := recorderWithServer(t, srv)
	r.Record(Event{Name: EventInstallStart})
	r.Record(Event{Name: EventInstallComplete, Properties: map[string]any{"version": "1.0.0"}})

	if err := r.Flush(); err != nil {
		t.Fatalf("Flush: %v", err)
	}

	if received.DeviceID != "test-device" {
		t.Errorf("DeviceID = %q, want test-device", received.DeviceID)
	}
	if len(received.Events) != 2 {
		t.Fatalf("got %d events, want 2", len(received.Events))
	}
	if received.Events[0].Name != EventInstallStart {
		t.Errorf("event[0].Name = %q, want %q", received.Events[0].Name, EventInstallStart)
	}
	if received.Events[1].Name != EventInstallComplete {
		t.Errorf("event[1].Name = %q, want %q", received.Events[1].Name, EventInstallComplete)
	}
}

func TestRecorder_Flush_clearsQueue(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	r := recorderWithServer(t, srv)
	r.Record(Event{Name: EventInstallStart})
	_ = r.Flush()

	r.mu.Lock()
	n := len(r.queue)
	r.mu.Unlock()
	if n != 0 {
		t.Errorf("queue not cleared after Flush: len=%d", n)
	}
}

func TestRecorder_Flush_networkError_silenced(t *testing.T) {
	// Point at a port that refuses connections.
	r := newWithConfig(Config{Enabled: true, DeviceID: newUUID()})
	r.client = &http.Client{Timeout: 200 * time.Millisecond}
	// Replace send to use a bad URL; Flush should not return an error.
	r.Record(Event{Name: EventInstallError})

	// Override the internal URL by monkey-patching via a custom transport.
	r.client.Transport = &failTransport{}
	err := r.Flush()
	// Network errors must be silenced — Flush returns nil.
	if err != nil {
		t.Errorf("Flush returned error on network failure: %v", err)
	}
}

// failTransport always returns a connection error.
type failTransport struct{}

func (failTransport) RoundTrip(*http.Request) (*http.Response, error) {
	return nil, fmt.Errorf("simulated network failure")
}

// ---- Event constant sanity ----

func TestEventConstants_defined(t *testing.T) {
	events := []string{
		EventInstallStart,
		EventInstallComplete,
		EventInstallError,
		EventUpdateStart,
		EventUpdateComplete,
		EventUpdateError,
		EventUninstall,
	}
	for _, e := range events {
		if e == "" {
			t.Error("empty event constant found")
		}
	}
}

// ---- Privacy: no PII in payload ----

func TestFlush_payload_noPII(t *testing.T) {
	var raw []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ = io.ReadAll(r.Body)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	r := recorderWithServer(t, srv)
	r.Record(Event{
		Name: EventInstallStart,
		Properties: map[string]any{
			"os": runtime.GOOS,
		},
	})
	_ = r.Flush()

	body := string(raw)
	// Hostname must not appear.
	hostname, _ := os.Hostname()
	if hostname != "" && strings.Contains(body, hostname) {
		t.Errorf("payload contains hostname %q", hostname)
	}
	// Username must not appear.
	username := os.Getenv("USER")
	if username != "" && strings.Contains(body, username) {
		t.Errorf("payload contains username %q", username)
	}
}
