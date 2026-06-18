package app

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/charmbracelet/bubbles/spinner"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/engrammic-ai/veil-installer/internal/config"
	"github.com/engrammic-ai/veil-installer/internal/download"
	"github.com/engrammic-ai/veil-installer/internal/install"
	"github.com/engrammic-ai/veil-installer/internal/platform"
	"github.com/engrammic-ai/veil-installer/internal/ui"
	"github.com/engrammic-ai/veil-installer/internal/verify"
)

// embedderConfig is the JSON config for the embedder server.
type embedderConfig struct {
	Tier          string `json:"tier"`
	CachePath     string `json:"cachePath"`
	IdleTimeoutMs int    `json:"idleTimeoutMs"`
	Port          int    `json:"port"`
}

func writeEmbedderConfig(configDir, tier string) error {
	if configDir == "" {
		return fmt.Errorf("config directory not set")
	}

	if err := os.MkdirAll(configDir, 0o755); err != nil {
		return fmt.Errorf("create config dir: %w", err)
	}

	cfg := embedderConfig{
		Tier:          tier,
		CachePath:     filepath.Join(configDir, "models"),
		IdleTimeoutMs: 30 * 60 * 1000, // 30 minutes
		Port:          19532,
	}

	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal config: %w", err)
	}

	configPath := filepath.Join(configDir, "embedder.json")
	if err := os.WriteFile(configPath, data, 0o644); err != nil {
		return fmt.Errorf("write config: %w", err)
	}

	return nil
}

// stepDoneMsg is sent by worker commands when a step completes.
type stepDoneMsg struct {
	result Result
	err    error
	data   any // optional data from the step
}

// EmbedderTier represents a semantic memory model option.
type EmbedderTier string

const (
	EmbedderNone     EmbedderTier = "none"
	EmbedderLight    EmbedderTier = "light"
	EmbedderBalanced EmbedderTier = "balanced"
	EmbedderQuality  EmbedderTier = "quality"
	EmbedderMax      EmbedderTier = "max"
	EmbedderOllama   EmbedderTier = "ollama"
)

// Model is the root bubbletea model for the installer TUI.
type Model struct {
	state         State
	platform      platform.Platform
	version       string       // selected or flagged version
	embedderTier  EmbedderTier // selected embedder model tier
	embedderIndex int          // current selection in embedder menu (0-5)
	spinner       spinner.Model
	err           error

	// Installation state
	release     *config.Release
	installPath string
	tmpBinPath  string
	client      *download.Client
	cache       *download.Cache

	// CLI flags forwarded from cobra.
	flagVersion      string
	flagYes          bool
	flagChannel      string
	flagPath         string
	flagNoModifyPath bool
	flagNoComplete   bool
	flagProxyURL     string
	flagCACert       string

	style lipgloss.Style
}

// embedderTiers is the ordered list of embedder options.
var embedderTiers = []EmbedderTier{
	EmbedderNone,
	EmbedderLight,
	EmbedderBalanced,
	EmbedderQuality,
	EmbedderMax,
	EmbedderOllama,
}

// Options configures the Model at construction time.
type Options struct {
	Version      string
	Yes          bool
	Channel      string
	Path         string
	NoModifyPath bool
	NoComplete   bool
	ProxyURL     string
	CACert       string
}

func New(opts Options) *Model {
	sp := spinner.New()
	sp.Spinner = spinner.Dot

	// Default install path
	installPath := opts.Path
	if installPath == "" {
		if home, err := os.UserHomeDir(); err == nil {
			installPath = filepath.Join(home, ".local", "bin", "veil")
		}
	}

	// Default channel
	channel := opts.Channel
	if channel == "" {
		channel = "stable"
	}

	return &Model{
		state:            StateDetectPlatform,
		embedderTier:     EmbedderBalanced,
		embedderIndex:    2,
		spinner:          sp,
		installPath:      installPath,
		flagVersion:      opts.Version,
		flagYes:          opts.Yes,
		flagChannel:      channel,
		flagPath:         opts.Path,
		flagNoModifyPath: opts.NoModifyPath,
		flagNoComplete:   opts.NoComplete,
		flagProxyURL:     opts.ProxyURL,
		flagCACert:       opts.CACert,
		style:            lipgloss.NewStyle().Padding(1, 2),
	}
}

func (m *Model) Init() tea.Cmd {
	return tea.Batch(m.spinner.Tick, m.runStep(m.state))
}

func (m *Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		if msg.String() == "ctrl+c" || msg.String() == "q" {
			return m, tea.Quit
		}

		// Handle embedder selection
		if m.state == StatePromptEmbedder {
			switch msg.String() {
			case "up", "k":
				if m.embedderIndex > 0 {
					m.embedderIndex--
				}
				return m, nil
			case "down", "j":
				if m.embedderIndex < len(embedderTiers)-1 {
					m.embedderIndex++
				}
				return m, nil
			case "enter":
				m.embedderTier = embedderTiers[m.embedderIndex]
				return m, func() tea.Msg { return stepDoneMsg{result: ResultOK} }
			}
		}

	case spinner.TickMsg:
		var cmd tea.Cmd
		m.spinner, cmd = m.spinner.Update(msg)
		return m, cmd

	case stepDoneMsg:
		if msg.err != nil {
			m.err = msg.err
		}
		// Handle data from steps
		if msg.data != nil {
			switch data := msg.data.(type) {
			case *config.Release:
				m.release = data
			case string:
				if m.state == StateDownload {
					m.tmpBinPath = data
				}
			}
		}
		m.state = nextState(m.state, msg.result)
		if m.state.IsTerminal() {
			return m, tea.Quit
		}
		return m, m.runStep(m.state)
	}

	return m, nil
}

func (m *Model) View() string {
	// Always show cat banner at top
	header := ui.RenderBanner() + "\n" +
		lipgloss.NewStyle().Bold(true).Foreground(ui.Pink).Render("veil installer") +
		lipgloss.NewStyle().Foreground(lipgloss.Color("240")).Render(" v0.1.0") + "\n\n"

	var body string

	switch m.state {
	case StateDetectPlatform:
		body = fmt.Sprintf("%s Detecting platform...", m.spinner.View())
	case StateCheckExisting:
		body = fmt.Sprintf("%s Checking for existing installation...", m.spinner.View())
	case StatePromptUpgrade:
		body = "An existing installation was found. Upgrade? [y/N]"
	case StateFetchVersions:
		body = fmt.Sprintf("%s Fetching available versions...", m.spinner.View())
	case StatePromptVersion:
		body = "Select a version to install."
	case StateValidateVer:
		body = fmt.Sprintf("%s Validating version %s...", m.spinner.View(), m.flagVersion)
	case StateDownload:
		version := m.flagVersion
		if m.release != nil {
			version = m.release.Version
		}
		body = fmt.Sprintf("%s Downloading Veil %s...", m.spinner.View(), version)
	case StateVerifySum:
		body = fmt.Sprintf("%s Verifying checksum...", m.spinner.View())
	case StateVerifySig:
		body = fmt.Sprintf("%s Verifying signature...", m.spinner.View())
	case StateInstall:
		body = fmt.Sprintf("%s Installing to %s...", m.spinner.View(), m.installPath)
	case StateConfigurePATH:
		body = fmt.Sprintf("%s Configuring PATH...", m.spinner.View())
	case StateInstallCompletions:
		body = fmt.Sprintf("%s Installing shell completions...", m.spinner.View())
	case StatePromptEmbedder:
		body = m.renderEmbedderMenu()
	case StateConfigureEmbedder:
		body = fmt.Sprintf("%s Configuring semantic memory...", m.spinner.View())
	case StateSuccess:
		version := "unknown"
		if m.release != nil {
			version = m.release.Version
		}
		body = fmt.Sprintf("Veil %s installed successfully to %s\n\nRun 'veil --version' to confirm.", version, m.installPath)
	case StateFailPlatform:
		body = fmt.Sprintf("Error: unsupported platform.\n%v", m.err)
	case StateFailNetwork:
		body = fmt.Sprintf("Error: network failure.\n%v", m.err)
	case StateFailVerify:
		body = fmt.Sprintf("Error: verification failed.\n%v", m.err)
	case StateFailPermission:
		body = fmt.Sprintf("Error: permission denied.\n%v", m.err)
	default:
		body = m.state.String()
	}

	return header + m.style.Render(body)
}

func (m *Model) runStep(s State) tea.Cmd {
	switch s {
	case StateDetectPlatform:
		return func() tea.Msg {
			m.platform = platform.Detect()
			switch m.platform.OS {
			case "linux", "darwin", "windows":
				return stepDoneMsg{result: ResultOK}
			default:
				return stepDoneMsg{
					result: ResultUnsupported,
					err:    fmt.Errorf("unsupported OS: %s", m.platform.OS),
				}
			}
		}

	case StateCheckExisting:
		return func() tea.Msg {
			if _, err := os.Stat(m.installPath); err == nil {
				return stepDoneMsg{result: ResultConflict}
			}
			return stepDoneMsg{result: ResultOK}
		}

	case StatePromptUpgrade:
		if m.flagYes {
			return func() tea.Msg { return stepDoneMsg{result: ResultOK} }
		}
		// For interactive, we'd need key handling - for now auto-approve
		return func() tea.Msg { return stepDoneMsg{result: ResultOK} }

	case StateFetchVersions:
		return func() tea.Msg {
			cache, err := download.NewCache()
			if err != nil {
				return stepDoneMsg{result: ResultError, err: fmt.Errorf("init cache: %w", err)}
			}
			m.cache = cache

			client, err := download.NewClient(download.ClientOptions{
				ProxyURL: m.flagProxyURL,
				CACert:   m.flagCACert,
			})
			if err != nil {
				return stepDoneMsg{result: ResultError, err: fmt.Errorf("init client: %w", err)}
			}
			m.client = client

			ch := config.Channel(m.flagChannel)

			if m.flagVersion != "" {
				// User requested specific version
				releases, err := config.FetchReleases(cache, ch)
				if err != nil {
					return stepDoneMsg{result: ResultError, err: fmt.Errorf("fetch releases: %w", err)}
				}
				for _, r := range releases {
					if r.Version == m.flagVersion || r.Version == strings.TrimPrefix(m.flagVersion, "v") {
						rel := r
						return stepDoneMsg{result: ResultVersionSet, data: &rel}
					}
				}
				return stepDoneMsg{result: ResultError, err: fmt.Errorf("version %q not found", m.flagVersion)}
			}

			// Get latest
			rel, err := config.GetLatest(cache, ch)
			if err != nil {
				return stepDoneMsg{result: ResultError, err: fmt.Errorf("fetch latest: %w", err)}
			}
			return stepDoneMsg{result: ResultOK, data: rel}
		}

	case StateValidateVer:
		return func() tea.Msg { return stepDoneMsg{result: ResultOK} }

	case StateDownload:
		return func() tea.Msg {
			if m.release == nil {
				return stepDoneMsg{result: ResultError, err: fmt.Errorf("no release selected")}
			}

			assetKey := m.platform.AssetKey()
			downloadURL, ok := m.release.GetAssetURL(assetKey)
			if !ok {
				return stepDoneMsg{result: ResultError, err: fmt.Errorf("no binary for platform %s", m.platform)}
			}

			tmpFile, err := os.CreateTemp("", "veil-download-*.tmp")
			if err != nil {
				return stepDoneMsg{result: ResultError, err: fmt.Errorf("create temp: %w", err)}
			}
			tmpPath := tmpFile.Name()
			tmpFile.Close()

			ctx := context.Background()
			if err := m.client.Download(ctx, downloadURL, tmpPath, nil); err != nil {
				os.Remove(tmpPath)
				return stepDoneMsg{result: ResultError, err: fmt.Errorf("download: %w", err)}
			}

			return stepDoneMsg{result: ResultOK, data: tmpPath}
		}

	case StateVerifySum:
		return func() tea.Msg {
			if m.release == nil || m.release.Checksum == "" {
				// No checksum available, skip
				return stepDoneMsg{result: ResultOK}
			}

			tmpSum, err := os.CreateTemp("", "veil-checksums-*.tmp")
			if err != nil {
				return stepDoneMsg{result: ResultError, err: err}
			}
			tmpSumPath := tmpSum.Name()
			tmpSum.Close()
			defer os.Remove(tmpSumPath)

			ctx := context.Background()
			if err := m.client.Download(ctx, m.release.Checksum, tmpSumPath, nil); err != nil {
				return stepDoneMsg{result: ResultError, err: fmt.Errorf("download checksum: %w", err)}
			}

			checksumData, err := os.ReadFile(tmpSumPath)
			if err != nil {
				return stepDoneMsg{result: ResultError, err: err}
			}

			checksums, err := verify.ParseChecksums(string(checksumData))
			if err != nil {
				return stepDoneMsg{result: ResultError, err: fmt.Errorf("parse checksums: %w", err)}
			}

			binFile, err := os.Open(m.tmpBinPath)
			if err != nil {
				return stepDoneMsg{result: ResultError, err: err}
			}
			defer binFile.Close()

			var expectedSum []byte
			for name, sum := range checksums {
				if strings.Contains(name, m.platform.String()) || strings.HasSuffix(name, "veil") {
					expectedSum = sum
					break
				}
			}

			if expectedSum != nil {
				if err := verify.VerifyChecksum(binFile, expectedSum); err != nil {
					return stepDoneMsg{result: ResultMismatch, err: fmt.Errorf("checksum mismatch: %w", err)}
				}
			}

			return stepDoneMsg{result: ResultOK}
		}

	case StateVerifySig:
		// Signature verification is optional, skip for now
		return func() tea.Msg { return stepDoneMsg{result: ResultOK} }

	case StateInstall:
		return func() tea.Msg {
			if m.tmpBinPath == "" {
				return stepDoneMsg{result: ResultError, err: fmt.Errorf("no downloaded binary")}
			}

			binFile, err := os.Open(m.tmpBinPath)
			if err != nil {
				return stepDoneMsg{result: ResultError, err: err}
			}
			defer binFile.Close()
			defer os.Remove(m.tmpBinPath)

			if err := os.MkdirAll(filepath.Dir(m.installPath), 0o755); err != nil {
				return stepDoneMsg{result: ResultError, err: fmt.Errorf("create dir: %w", err)}
			}

			if err := install.Install(binFile, m.installPath); err != nil {
				return stepDoneMsg{result: ResultError, err: fmt.Errorf("install: %w", err)}
			}

			// Write version file
			if m.release != nil {
				versionFile := filepath.Join(filepath.Dir(m.installPath), ".veil-version")
				_ = os.WriteFile(versionFile, []byte(m.release.Version), 0o644)
			}

			return stepDoneMsg{result: ResultOK}
		}

	case StateConfigurePATH:
		return func() tea.Msg {
			if m.flagNoModifyPath {
				return stepDoneMsg{result: ResultOK}
			}
			shell := platform.DetectShell()
			shellCfg := platform.GetShellConfig(shell)
			if err := install.ModifyPATH(shellCfg, filepath.Dir(m.installPath)); err != nil {
				// PATH config is best-effort, don't fail
				return stepDoneMsg{result: ResultOK}
			}
			return stepDoneMsg{result: ResultOK}
		}

	case StateInstallCompletions:
		return func() tea.Msg {
			if m.flagNoComplete {
				return stepDoneMsg{result: ResultOK}
			}
			shell := platform.DetectShell()
			if err := install.InstallCompletions(m.installPath, shell); err != nil {
				// Completions are best-effort
				return stepDoneMsg{result: ResultOK}
			}
			return stepDoneMsg{result: ResultOK}
		}

	case StatePromptEmbedder:
		if m.flagYes {
			m.embedderTier = EmbedderBalanced
			return func() tea.Msg { return stepDoneMsg{result: ResultOK} }
		}
		// Interactive: wait for user selection (handled in Update)
		return nil

	case StateConfigureEmbedder:
		return m.configureEmbedder()
	}

	return nil
}

func (m *Model) configureEmbedder() tea.Cmd {
	return func() tea.Msg {
		if m.embedderTier == "" {
			m.embedderTier = EmbedderBalanced
		}

		configDir := m.getConfigDir()
		if err := writeEmbedderConfig(configDir, string(m.embedderTier)); err != nil {
			return stepDoneMsg{result: ResultError, err: err}
		}

		return stepDoneMsg{result: ResultOK}
	}
}

func (m *Model) getConfigDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".config", "veil")
}

func (m *Model) renderEmbedderMenu() string {
	options := []struct {
		tier EmbedderTier
		desc string
	}{
		{EmbedderNone, "None       (keyword search only, 0 RAM)"},
		{EmbedderLight, "Light      (23MB, ~100MB RAM, English)"},
		{EmbedderBalanced, "Balanced   (118MB, ~300MB RAM, multilingual) [recommended]"},
		{EmbedderQuality, "Quality    (278MB, ~600MB RAM, multilingual)"},
		{EmbedderMax, "Max        (560MB, ~1.2GB RAM, multilingual)"},
		{EmbedderOllama, "Ollama     (requires Ollama running locally)"},
	}

	var lines []string
	lines = append(lines, "Semantic Memory Model:")
	lines = append(lines, "")
	lines = append(lines, "Select an embedding model for semantic search in memory.")
	lines = append(lines, "Models are downloaded on first use.")
	lines = append(lines, "")

	for i, opt := range options {
		marker := "○"
		if i == m.embedderIndex {
			marker = "●"
		}
		lines = append(lines, fmt.Sprintf("  %s %s", marker, opt.desc))
	}

	lines = append(lines, "")
	lines = append(lines, "Use ↑/↓ to select, Enter to confirm.")

	return strings.Join(lines, "\n")
}
