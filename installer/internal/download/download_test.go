package download

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// ---- Client tests ----

func TestClientDownload_success(t *testing.T) {
	body := []byte("hello veil")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write(body)
	}))
	defer srv.Close()

	c, err := NewClient(ClientOptions{})
	if err != nil {
		t.Fatal(err)
	}

	dest := filepath.Join(t.TempDir(), "out")
	if err := c.Download(context.Background(), srv.URL, dest, nil); err != nil {
		t.Fatal(err)
	}

	got, _ := os.ReadFile(dest)
	if !bytes.Equal(got, body) {
		t.Fatalf("got %q, want %q", got, body)
	}
}

func TestClientDownload_retries_on_5xx(t *testing.T) {
	attempts := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts++
		if attempts < 3 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.Write([]byte("ok"))
	}))
	defer srv.Close()

	c, err := NewClient(ClientOptions{Timeout: 10 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	// Override base delay to speed up test.
	dest := filepath.Join(t.TempDir(), "out")
	if err := c.Download(context.Background(), srv.URL, dest, nil); err != nil {
		t.Fatalf("expected success after retries, got: %v", err)
	}
	if attempts != 3 {
		t.Fatalf("expected 3 attempts, got %d", attempts)
	}
}

func TestClientDownload_nonTransient_no_retry(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	c, err := NewClient(ClientOptions{})
	if err != nil {
		t.Fatal(err)
	}
	dest := filepath.Join(t.TempDir(), "out")
	err = c.Download(context.Background(), srv.URL, dest, nil)
	if err == nil {
		t.Fatal("expected error for 404")
	}
	if !strings.Contains(err.Error(), "404") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestClientDownload_progressCallback(t *testing.T) {
	body := bytes.Repeat([]byte("x"), 1024)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "1024")
		w.Write(body)
	}))
	defer srv.Close()

	c, _ := NewClient(ClientOptions{})
	var calls []Progress
	dest := filepath.Join(t.TempDir(), "out")
	err := c.Download(context.Background(), srv.URL, dest, func(p Progress) {
		calls = append(calls, p)
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(calls) == 0 {
		t.Fatal("expected at least one progress callback")
	}
	last := calls[len(calls)-1]
	if last.Bytes != 1024 {
		t.Fatalf("last progress bytes = %d, want 1024", last.Bytes)
	}
}

func TestClientDownload_contextCancel(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Hang indefinitely.
		<-r.Context().Done()
	}))
	defer srv.Close()

	c, _ := NewClient(ClientOptions{})
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()

	dest := filepath.Join(t.TempDir(), "out")
	err := c.Download(ctx, srv.URL, dest, nil)
	if err == nil {
		t.Fatal("expected error when context cancelled")
	}
}

// ---- ProgressReader tests ----

func TestProgressReader_tracksBytesAndSpeed(t *testing.T) {
	data := bytes.Repeat([]byte("a"), 512)
	var last Progress
	pr := &ProgressReader{
		Reader: bytes.NewReader(data),
		Total:  512,
		OnProgress: func(p Progress) {
			last = p
		},
	}

	buf := make([]byte, 1024)
	n, _ := pr.Read(buf)
	if n != 512 {
		t.Fatalf("expected 512 bytes, got %d", n)
	}
	if last.Bytes != 512 {
		t.Fatalf("progress.Bytes = %d, want 512", last.Bytes)
	}
	if last.Total != 512 {
		t.Fatalf("progress.Total = %d, want 512", last.Total)
	}
}

// ---- Cache tests ----

func cacheWithTempDir(t *testing.T) *Cache {
	t.Helper()
	dir := t.TempDir()
	base := filepath.Join(dir, cacheDir)
	_ = os.MkdirAll(filepath.Join(base, downloadsDir), 0o700)
	return &Cache{base: base}
}

func TestCache_GetMiss(t *testing.T) {
	c := cacheWithTempDir(t)
	if got := c.Get("0.3.1", "linux-arm64"); got != "" {
		t.Fatalf("expected cache miss, got %q", got)
	}
}

func TestCache_PutAndGet(t *testing.T) {
	c := cacheWithTempDir(t)
	data := []byte("binary-data")
	if err := c.Put("0.3.1", "linux-arm64", bytes.NewReader(data)); err != nil {
		t.Fatal(err)
	}
	path := c.Get("0.3.1", "linux-arm64")
	if path == "" {
		t.Fatal("expected cache hit after Put")
	}
	got, _ := os.ReadFile(path)
	if !bytes.Equal(got, data) {
		t.Fatalf("cached content mismatch")
	}
}

func TestCache_PruneKeepsLastTwo(t *testing.T) {
	c := cacheWithTempDir(t)
	for _, ver := range []string{"0.1.0", "0.2.0", "0.3.0"} {
		if err := c.Put(ver, "linux-amd64", bytes.NewReader([]byte(ver))); err != nil {
			t.Fatal(err)
		}
		// Small sleep so mtime differs.
		time.Sleep(5 * time.Millisecond)
	}

	// After Put("0.3.0") pruning runs automatically (keep=2).
	if c.Get("0.1.0", "linux-amd64") != "" {
		t.Error("0.1.0 should have been pruned")
	}
	if c.Get("0.2.0", "linux-amd64") == "" {
		t.Error("0.2.0 should be kept")
	}
	if c.Get("0.3.0", "linux-amd64") == "" {
		t.Error("0.3.0 should be kept")
	}
}

func TestCache_VersionsTTL(t *testing.T) {
	c := cacheWithTempDir(t)
	raw := json.RawMessage(`["0.3.1","0.3.0"]`)
	if err := c.PutVersions(raw); err != nil {
		t.Fatal(err)
	}
	got, ok := c.GetVersions()
	if !ok {
		t.Fatal("expected cache hit within TTL")
	}
	if string(got) != string(raw) {
		t.Fatalf("versions mismatch: %s", got)
	}
}

func TestCache_VersionsTTL_expired(t *testing.T) {
	c := cacheWithTempDir(t)
	// Write an entry with a past timestamp.
	entry := versionsEntry{
		Data:      json.RawMessage(`["0.3.0"]`),
		FetchedAt: time.Now().Add(-2 * time.Hour),
	}
	out, _ := json.Marshal(entry)
	os.WriteFile(filepath.Join(c.base, versionsFile), out, 0o600)

	_, ok := c.GetVersions()
	if ok {
		t.Fatal("expected cache miss for expired versions")
	}
}

func TestCache_ChecksumRoundtrip(t *testing.T) {
	c := cacheWithTempDir(t)
	data := []byte("sha256  veil-0.3.1-linux-amd64\n")
	if err := c.PutChecksum("0.3.1", data); err != nil {
		t.Fatal(err)
	}
	got := c.GetChecksum("0.3.1")
	if !bytes.Equal(got, data) {
		t.Fatalf("checksum mismatch: got %q", got)
	}
}
