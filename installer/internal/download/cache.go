package download

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
)

const (
	cacheDir     = "veil-installer"
	downloadsDir = "downloads"
	versionsFile = "versions.json"
	versionsTTL  = time.Hour
	defaultKeep  = 2
)

// Cache manages downloaded binaries in an XDG-compatible directory.
type Cache struct {
	base string
}

// versionsEntry is the on-disk format for versions.json.
type versionsEntry struct {
	Data      json.RawMessage `json:"data"`
	FetchedAt time.Time       `json:"fetched_at"`
}

// NewCache returns a Cache rooted at the platform-appropriate cache directory.
func NewCache() (*Cache, error) {
	base, err := baseCacheDir()
	if err != nil {
		return nil, fmt.Errorf("resolve cache dir: %w", err)
	}
	base = filepath.Join(base, cacheDir)
	for _, sub := range []string{base, filepath.Join(base, downloadsDir)} {
		if err := os.MkdirAll(sub, 0o700); err != nil {
			return nil, fmt.Errorf("create cache dir %s: %w", sub, err)
		}
	}
	return &Cache{base: base}, nil
}

// baseCacheDir returns the OS-specific cache root.
func baseCacheDir() (string, error) {
	switch runtime.GOOS {
	case "linux":
		if xdg := os.Getenv("XDG_CACHE_HOME"); xdg != "" {
			return xdg, nil
		}
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		return filepath.Join(home, ".cache"), nil

	case "darwin":
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		return filepath.Join(home, "Library", "Caches"), nil

	case "windows":
		local := os.Getenv("LOCALAPPDATA")
		if local == "" {
			home, err := os.UserHomeDir()
			if err != nil {
				return "", err
			}
			local = filepath.Join(home, "AppData", "Local")
		}
		return filepath.Join(local, "cache"), nil

	default:
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		return filepath.Join(home, ".cache"), nil
	}
}

// entryName builds the filename for a cached binary.
func entryName(version, platform string) string {
	return fmt.Sprintf("veil-%s-%s", version, platform)
}

// Get returns the path to a cached binary, or "" if not cached.
func (c *Cache) Get(version, platform string) string {
	p := filepath.Join(c.base, downloadsDir, entryName(version, platform))
	if _, err := os.Stat(p); err == nil {
		return p
	}
	return ""
}

// Put stores data as a cached binary for the given version+platform, then
// prunes old entries keeping only the last defaultKeep versions.
func (c *Cache) Put(version, platform string, data io.Reader) error {
	dest := filepath.Join(c.base, downloadsDir, entryName(version, platform))
	tmp := dest + ".tmp"

	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return fmt.Errorf("create temp file: %w", err)
	}
	if _, err := io.Copy(f, data); err != nil {
		f.Close()
		os.Remove(tmp)
		return fmt.Errorf("write cache entry: %w", err)
	}
	f.Close()

	if err := os.Rename(tmp, dest); err != nil {
		os.Remove(tmp)
		return fmt.Errorf("commit cache entry: %w", err)
	}

	return c.PruneOldVersions(defaultKeep)
}

// PruneOldVersions keeps at most keep versions per platform, removing oldest first.
func (c *Cache) PruneOldVersions(keep int) error {
	dir := filepath.Join(c.base, downloadsDir)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return fmt.Errorf("read downloads dir: %w", err)
	}

	// Group files by platform suffix.
	type fileInfo struct {
		name    string
		modTime time.Time
	}
	byPlatform := map[string][]fileInfo{}

	for _, e := range entries {
		if e.IsDir() || strings.HasSuffix(e.Name(), ".tmp") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		// Expected format: veil-<version>-<platform>
		// Platform is everything after "veil-<version>-".
		parts := strings.SplitN(e.Name(), "-", 3)
		if len(parts) < 3 {
			continue
		}
		platform := parts[2]
		byPlatform[platform] = append(byPlatform[platform], fileInfo{
			name:    filepath.Join(dir, e.Name()),
			modTime: info.ModTime(),
		})
	}

	for _, files := range byPlatform {
		if len(files) <= keep {
			continue
		}
		sort.Slice(files, func(i, j int) bool {
			return files[i].modTime.Before(files[j].modTime)
		})
		for _, f := range files[:len(files)-keep] {
			os.Remove(f.name)
		}
	}
	return nil
}

// GetVersions returns cached version data and true if the cache is still valid (TTL).
func (c *Cache) GetVersions() (json.RawMessage, bool) {
	p := filepath.Join(c.base, versionsFile)
	data, err := os.ReadFile(p)
	if err != nil {
		return nil, false
	}
	var entry versionsEntry
	if err := json.Unmarshal(data, &entry); err != nil {
		return nil, false
	}
	if time.Since(entry.FetchedAt) > versionsTTL {
		return nil, false
	}
	return entry.Data, true
}

// PutVersions writes version data to the cache.
func (c *Cache) PutVersions(data json.RawMessage) error {
	entry := versionsEntry{Data: data, FetchedAt: time.Now()}
	out, err := json.Marshal(entry)
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(c.base, versionsFile), out, 0o600)
}

// PutChecksum writes a checksum file for a given version.
func (c *Cache) PutChecksum(version string, data []byte) error {
	name := fmt.Sprintf("checksums-%s.txt", version)
	return os.WriteFile(filepath.Join(c.base, name), data, 0o600)
}

// GetChecksum returns the cached checksum file content for a version, or nil.
func (c *Cache) GetChecksum(version string) []byte {
	name := fmt.Sprintf("checksums-%s.txt", version)
	data, _ := os.ReadFile(filepath.Join(c.base, name))
	return data
}
