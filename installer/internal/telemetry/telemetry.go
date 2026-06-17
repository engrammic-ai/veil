// Package telemetry provides opt-in anonymous usage tracking.
//
// Privacy guarantees:
//   - Disabled by default; users must explicitly enable.
//   - No PII collected: no IP address, hostname, or username.
//   - DeviceID is a random UUID generated locally; it is not tied to hardware.
//   - Config stored at ~/.config/veil/telemetry.json (XDG_CONFIG_HOME respected).
package telemetry

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"time"
)

const (
	configDir      = "veil"
	configFile     = "telemetry.json"
	telemetryURL   = "https://telemetry.veil.dev/v1/events"
	flushTimeout   = 5 * time.Second
	maxQueuedEvents = 100
)

// Event names used throughout the installer.
const (
	EventInstallStart    = "install_start"
	EventInstallComplete = "install_complete"
	EventInstallError    = "install_error"
	EventUpdateStart     = "update_start"
	EventUpdateComplete  = "update_complete"
	EventUpdateError     = "update_error"
	EventUninstall       = "uninstall"
)

// Config holds the persisted telemetry settings.
type Config struct {
	// Enabled controls whether events are recorded. False by default.
	Enabled bool `json:"enabled"`
	// DeviceID is a random UUID that persists across sessions. It is not
	// derived from hardware identifiers and carries no PII.
	DeviceID string `json:"device_id"`
}

// Event is a single telemetry data point.
type Event struct {
	Name       string         `json:"name"`
	Properties map[string]any `json:"properties,omitempty"`
	Timestamp  time.Time      `json:"timestamp"`
}

// Recorder queues events and sends them in a batch on Flush.
type Recorder struct {
	cfg    Config
	mu     sync.Mutex
	queue  []Event
	client *http.Client
}

// New returns a Recorder loaded from the XDG config file.
// If the config file does not exist, a disabled Recorder is returned.
// Use Enable() + SaveConfig() if you want to activate telemetry after consent.
func New() (*Recorder, error) {
	cfg, err := LoadConfig()
	if err != nil {
		// Treat a missing/corrupt config as disabled — never block the installer.
		cfg = Config{}
	}
	return newWithConfig(cfg), err
}

// newWithConfig constructs a Recorder from an explicit Config (testable).
func newWithConfig(cfg Config) *Recorder {
	return &Recorder{
		cfg:    cfg,
		client: &http.Client{Timeout: flushTimeout},
	}
}

// Enabled reports whether telemetry is active.
func (r *Recorder) Enabled() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.cfg.Enabled
}

// Enable turns on telemetry for this session. Call SaveConfig to persist.
func (r *Recorder) Enable() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.cfg.Enabled = true
	if r.cfg.DeviceID == "" {
		r.cfg.DeviceID = newUUID()
	}
}

// Disable turns off telemetry for this session. Call SaveConfig to persist.
func (r *Recorder) Disable() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.cfg.Enabled = false
}

// Record enqueues an event. It is a no-op when telemetry is disabled.
// Properties must not contain PII; the caller is responsible for this.
func (r *Recorder) Record(event Event) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.cfg.Enabled {
		return
	}
	if event.Timestamp.IsZero() {
		event.Timestamp = time.Now().UTC()
	}
	if len(r.queue) >= maxQueuedEvents {
		// Drop oldest to bound memory usage.
		r.queue = r.queue[1:]
	}
	r.queue = append(r.queue, event)
}

// Flush sends all queued events to the telemetry endpoint and clears the queue.
// It is a no-op when telemetry is disabled or the queue is empty.
// Network errors are silently discarded so the installer is never blocked.
func (r *Recorder) Flush() error {
	r.mu.Lock()
	if !r.cfg.Enabled || len(r.queue) == 0 {
		r.mu.Unlock()
		return nil
	}
	batch := make([]Event, len(r.queue))
	copy(batch, r.queue)
	r.queue = r.queue[:0]
	deviceID := r.cfg.DeviceID
	r.mu.Unlock()

	return r.send(deviceID, batch)
}

// payload is the JSON body sent to the telemetry endpoint.
type payload struct {
	DeviceID string  `json:"device_id"`
	Events   []Event `json:"events"`
}

func (r *Recorder) send(deviceID string, events []Event) error {
	body := payload{DeviceID: deviceID, Events: events}
	data, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("telemetry marshal: %w", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), flushTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, telemetryURL, bytes.NewReader(data))
	if err != nil {
		return fmt.Errorf("telemetry request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := r.client.Do(req)
	if err != nil {
		// Network failure — silently ignore.
		return nil
	}
	resp.Body.Close()
	return nil
}

// LoadConfig reads the telemetry config from the XDG config directory.
// Returns an empty Config (disabled) if the file does not exist.
func LoadConfig() (Config, error) {
	p, err := configPath()
	if err != nil {
		return Config{}, fmt.Errorf("telemetry config path: %w", err)
	}
	data, err := os.ReadFile(p)
	if os.IsNotExist(err) {
		return Config{}, nil
	}
	if err != nil {
		return Config{}, fmt.Errorf("read telemetry config: %w", err)
	}
	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return Config{}, fmt.Errorf("parse telemetry config: %w", err)
	}
	return cfg, nil
}

// SaveConfig writes cfg to the XDG config directory, creating directories as needed.
func SaveConfig(cfg Config) error {
	p, err := configPath()
	if err != nil {
		return fmt.Errorf("telemetry config path: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return fmt.Errorf("create config dir: %w", err)
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal telemetry config: %w", err)
	}
	return os.WriteFile(p, data, 0o600)
}

// configPath returns the platform-appropriate path for telemetry.json.
func configPath() (string, error) {
	base, err := baseConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(base, configDir, configFile), nil
}

// baseConfigDir returns the OS-specific config root, respecting XDG on Linux.
func baseConfigDir() (string, error) {
	switch runtime.GOOS {
	case "linux":
		if xdg := os.Getenv("XDG_CONFIG_HOME"); xdg != "" {
			return xdg, nil
		}
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		return filepath.Join(home, ".config"), nil

	case "darwin":
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		return filepath.Join(home, "Library", "Application Support"), nil

	case "windows":
		appData := os.Getenv("APPDATA")
		if appData == "" {
			home, err := os.UserHomeDir()
			if err != nil {
				return "", err
			}
			appData = filepath.Join(home, "AppData", "Roaming")
		}
		return appData, nil

	default:
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		return filepath.Join(home, ".config"), nil
	}
}

// newUUID generates a random RFC 4122 v4 UUID string.
// It panics only if the OS random source is broken, which is unrecoverable.
func newUUID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(fmt.Sprintf("telemetry: crypto/rand unavailable: %v", err))
	}
	// Set version 4 and variant bits.
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%s-%s-%s-%s-%s",
		hex.EncodeToString(b[0:4]),
		hex.EncodeToString(b[4:6]),
		hex.EncodeToString(b[6:8]),
		hex.EncodeToString(b[8:10]),
		hex.EncodeToString(b[10:16]),
	)
}
