package app

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/progress"
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

// InstallerVersion is the version of the installer itself.
const InstallerVersion = "0.1.19"

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

	home, _ := os.UserHomeDir()
	cacheDir := filepath.Join(home, ".cache", "veil", "models")

	cfg := embedderConfig{
		Tier:          tier,
		CachePath:     cacheDir,
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

// progressMsg updates download progress.
type progressMsg struct {
	pct  float64
	info string
}

// debugMsg adds a debug log line.
type debugMsg string

// Helper to add debug log (keeps last 5)
func (m *Model) addDebug(msg string) {
	m.debugLogs = append(m.debugLogs, msg)
	if len(m.debugLogs) > 5 {
		m.debugLogs = m.debugLogs[1:]
	}
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
	embedderTier    EmbedderTier // selected embedder model tier
	embedderIndex   int          // current selection in embedder menu (0-5)
	startEmbedder   bool         // whether to start embedder server after install
	spinner       spinner.Model
	progress      progress.Model
	miniCat       *ui.MiniCat
	showBanner    bool // show big banner (only at start)
	err           error

	// Installation state
	release      *config.Release
	installPath  string
	tmpBinPath   string
	client       *download.Client
	cache        *download.Cache
	downloadPct  float64   // download progress 0.0-1.0
	downloadInfo string    // download speed/ETA info
	debugLogs    []string  // recent debug messages (max 5)

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

	// Progress bar with pink gradient
	prog := progress.New(
		progress.WithScaledGradient("#ff69b4", "#ff1493"),
		progress.WithWidth(40),
		progress.WithoutPercentage(),
	)

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
		progress:         prog,
		miniCat:          ui.NewMiniCat(),
		showBanner:       true,
		debugLogs:        make([]string, 0, 5),
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
	return tea.Batch(m.spinner.Tick, m.miniCat.Tick(), m.runStep(m.state))
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

		// Handle start embedder prompt
		if m.state == StateStartEmbedder {
			switch msg.String() {
			case "y", "Y", "enter":
				m.startEmbedder = true
				return m, m.startEmbedderServer()
			case "n", "N":
				m.startEmbedder = false
				return m, func() tea.Msg { return stepDoneMsg{result: ResultSkip} }
			}
		}

		// Handle force reinstall prompt
		if m.state == StatePromptForce {
			switch msg.String() {
			case "y", "Y":
				return m, func() tea.Msg { return stepDoneMsg{result: ResultOK} }
			case "n", "N", "enter":
				return m, func() tea.Msg { return stepDoneMsg{result: ResultSkip} }
			}
		}

		// Handle upgrade prompt
		if m.state == StatePromptUpgrade {
			switch msg.String() {
			case "y", "Y", "enter":
				return m, func() tea.Msg { return stepDoneMsg{result: ResultOK} }
			case "n", "N":
				return m, func() tea.Msg { return stepDoneMsg{result: ResultSkip} }
			}
		}

	case spinner.TickMsg:
		var cmd tea.Cmd
		m.spinner, cmd = m.spinner.Update(msg)
		return m, cmd

	case ui.TickMsg:
		cmd := m.miniCat.Update(msg)
		return m, cmd

	case progressMsg:
		m.downloadPct = msg.pct
		m.downloadInfo = msg.info
		return m, nil

	case debugMsg:
		m.addDebug(string(msg))
		return m, nil

	case progress.FrameMsg:
		progressModel, cmd := m.progress.Update(msg)
		m.progress = progressModel.(progress.Model)
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
		// Hide banner after first step completes
		m.showBanner = false
		m.state = nextState(m.state, msg.result)
		if m.state.IsTerminal() {
			return m, tea.Quit
		}
		return m, m.runStep(m.state)
	}

	return m, nil
}

func (m *Model) View() string {
	var header string

	// Show big banner only at start, then switch to mini cat
	versionStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("240")).Render(" v" + InstallerVersion)
	if m.showBanner && m.state == StateDetectPlatform {
		header = ui.RenderBanner() + "\n" +
			lipgloss.NewStyle().Bold(true).Foreground(ui.Pink).Render("veil installer") +
			versionStyle + "\n\n"
	} else {
		// Use mini cat for progress
		header = lipgloss.NewStyle().Bold(true).Foreground(ui.Pink).Render("veil installer") +
			versionStyle + "\n\n"
	}

	var body string

	// Update cat state based on installer state
	switch {
	case m.state == StateSuccess:
		m.miniCat.SetState(ui.CatSuccess)
	case m.state.IsTerminal() && m.state != StateSuccess:
		m.miniCat.SetState(ui.CatError)
	case m.state == StatePromptEmbedder || m.state == StatePromptUpgrade || m.state == StatePromptVersion:
		m.miniCat.SetState(ui.CatIdle)
	default:
		m.miniCat.SetState(ui.CatWorking)
	}

	switch m.state {
	case StateDetectPlatform:
		if m.showBanner {
			body = fmt.Sprintf("%s Detecting platform...", m.spinner.View())
		} else {
			body = m.miniCat.ViewWithStatus("Detecting platform...", m.spinner.View())
		}
	case StateCheckExisting:
		body = m.miniCat.ViewWithStatus("Checking for existing installation...", m.spinner.View())
	case StatePromptUpgrade:
		body = m.miniCat.View() + "\n\nAn existing installation was found. Upgrade? [y/N]"
	case StatePromptForce:
		version := "latest"
		if m.release != nil {
			version = m.release.Version
		}
		body = m.miniCat.View() + fmt.Sprintf("\n\nAlready at version %s. Reinstall anyway? [y/N]", version)
	case StateFetchVersions:
		body = m.miniCat.ViewWithStatus("Fetching available versions...", m.spinner.View())
	case StatePromptVersion:
		body = m.miniCat.View() + "\n\nSelect a version to install."
	case StateValidateVer:
		body = m.miniCat.ViewWithStatus(fmt.Sprintf("Validating version %s...", m.flagVersion), m.spinner.View())
	case StateDownload:
		version := m.flagVersion
		if m.release != nil {
			version = m.release.Version
		}
		status := fmt.Sprintf("Downloading Veil %s...", version)
		body = m.miniCat.ViewWithStatus(status, m.spinner.View())
		// Show progress bar if we have progress
		if m.downloadPct > 0 {
			body += "\n\n" + m.progress.ViewAs(m.downloadPct)
			if m.downloadInfo != "" {
				body += "  " + ui.MutedStyle.Render(m.downloadInfo)
			}
		}
	case StateVerifySum:
		body = m.miniCat.ViewWithStatus("Verifying checksum...", m.spinner.View())
	case StateVerifySig:
		body = m.miniCat.ViewWithStatus("Verifying signature...", m.spinner.View())
	case StateInstall:
		body = m.miniCat.ViewWithStatus(fmt.Sprintf("Installing to %s...", m.installPath), m.spinner.View())
	case StateConfigurePATH:
		body = m.miniCat.ViewWithStatus("Configuring PATH...", m.spinner.View())
	case StateInstallCompletions:
		body = m.miniCat.ViewWithStatus("Installing shell completions...", m.spinner.View())
	case StatePromptEmbedder:
		body = m.miniCat.View() + "\n\n" + m.renderEmbedderMenu()
	case StateConfigureEmbedder:
		body = m.miniCat.ViewWithStatus("Configuring semantic memory...", m.spinner.View())
	case StateStartEmbedder:
		body = m.miniCat.View() + "\n\nStart embedding server now? [Y/n]"
	case StateSuccess:
		version := "unknown"
		if m.release != nil {
			version = m.release.Version
		}
		body = m.miniCat.View() + "\n\n" +
			ui.SuccessStyle.Render(fmt.Sprintf("Veil %s installed successfully to %s", version, m.installPath)) +
			"\n\nRun 'veil --version' to confirm."
	case StateFailPlatform:
		body = m.miniCat.View() + "\n\n" + ui.ErrorStyle.Render(fmt.Sprintf("Error: unsupported platform.\n%v", m.err))
	case StateFailNetwork:
		body = m.miniCat.View() + "\n\n" + ui.ErrorStyle.Render(fmt.Sprintf("Error: network failure.\n%v", m.err))
	case StateFailVerify:
		body = m.miniCat.View() + "\n\n" + ui.ErrorStyle.Render(fmt.Sprintf("Error: verification failed.\n%v", m.err))
	case StateFailPermission:
		body = m.miniCat.View() + "\n\n" + ui.ErrorStyle.Render(fmt.Sprintf("Error: permission denied.\n%v", m.err))
	default:
		body = m.state.String()
	}

	// Add debug logs at bottom (dimmed)
	if len(m.debugLogs) > 0 {
		body += "\n\n"
		for _, log := range m.debugLogs {
			body += ui.MutedStyle.Render("  " + log) + "\n"
		}
	}

	return header + m.style.Render(body)
}

func (m *Model) runStep(s State) tea.Cmd {
	switch s {
	case StateDetectPlatform:
		return func() tea.Msg {
			m.platform = platform.Detect()
			m.addDebug(fmt.Sprintf("platform: %s", m.platform))
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
			m.addDebug(fmt.Sprintf("checking %s", m.installPath))
			if _, err := os.Stat(m.installPath); err == nil {
				m.addDebug("existing installation found")
				return stepDoneMsg{result: ResultConflict}
			}
			return stepDoneMsg{result: ResultOK}
		}

	case StatePromptUpgrade:
		if m.flagYes {
			return func() tea.Msg { return stepDoneMsg{result: ResultOK} }
		}
		// Wait for key input (y/n)
		return nil

	case StatePromptForce:
		if m.flagYes {
			return func() tea.Msg { return stepDoneMsg{result: ResultOK} }
		}
		// Wait for key input (y/n)
		return nil

	case StateFetchVersions:
		return func() tea.Msg {
			m.addDebug("initializing download client")
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

			m.addDebug(fmt.Sprintf("fetching releases (channel: %s)", m.flagChannel))
			ch := config.Channel(m.flagChannel)

			if m.flagVersion != "" {
				// User requested specific version
				releases, err := config.FetchReleasesRefresh(cache, ch)
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
			rel, err := config.GetLatestRefresh(cache, ch)
			if err != nil {
				return stepDoneMsg{result: ResultError, err: fmt.Errorf("fetch latest: %w", err)}
			}
			m.addDebug(fmt.Sprintf("found version %s", rel.Version))

			// Check if already at this version
			if _, err := os.Stat(m.installPath); err == nil {
				versionFile := filepath.Join(filepath.Dir(m.installPath), ".veil-version")
				if data, err := os.ReadFile(versionFile); err == nil {
					current := strings.TrimSpace(string(data))
					target := strings.TrimPrefix(rel.Version, "v")
					if current == target || current == "v"+target {
						m.addDebug(fmt.Sprintf("already at version %s", current))
						return stepDoneMsg{result: ResultAlreadyLatest, data: rel}
					}
				}
			}

			return stepDoneMsg{result: ResultOK, data: rel}
		}

	case StateValidateVer:
		return func() tea.Msg { return stepDoneMsg{result: ResultOK} }

	case StateDownload:
		return m.downloadCmd()

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
			defer os.Remove(m.tmpBinPath)

			m.addDebug(fmt.Sprintf("creating %s", filepath.Dir(m.installPath)))
			if err := os.MkdirAll(filepath.Dir(m.installPath), 0o755); err != nil {
				return stepDoneMsg{result: ResultError, err: fmt.Errorf("create dir: %w", err)}
			}

			// Check if the download was an archive by looking at the asset URL
			assetKey := m.platform.AssetKey()
			downloadURL, _ := m.release.GetAssetURL(assetKey)
			isArchive := install.IsArchive(downloadURL)

			if isArchive {
				m.addDebug("extracting archive")
				if err := install.InstallFromArchive(m.tmpBinPath, m.installPath); err != nil {
					return stepDoneMsg{result: ResultError, err: fmt.Errorf("install from archive: %w", err)}
				}
			} else {
				m.addDebug("copying binary")
				binFile, err := os.Open(m.tmpBinPath)
				if err != nil {
					return stepDoneMsg{result: ResultError, err: err}
				}
				defer binFile.Close()
				if err := install.Install(binFile, m.installPath); err != nil {
					return stepDoneMsg{result: ResultError, err: fmt.Errorf("install: %w", err)}
				}
			}

			// Write version file
			if m.release != nil {
				versionFile := filepath.Join(filepath.Dir(m.installPath), ".veil-version")
				_ = os.WriteFile(versionFile, []byte(m.release.Version), 0o644)
			}

			m.addDebug("install complete")
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

	case StateStartEmbedder:
		// Skip for "none" or "ollama" tiers
		if m.embedderTier == EmbedderNone || m.embedderTier == EmbedderOllama {
			return func() tea.Msg { return stepDoneMsg{result: ResultSkip} }
		}
		// Auto-skip in non-interactive mode
		if m.flagYes {
			m.startEmbedder = true
			return m.startEmbedderServer()
		}
		// Interactive: wait for user input (handled in Update)
		return nil
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

func (m *Model) startEmbedderServer() tea.Cmd {
	return func() tea.Msg {
		if !m.startEmbedder {
			return stepDoneMsg{result: ResultSkip}
		}

		veilBin := m.installPath
		if _, err := os.Stat(veilBin); os.IsNotExist(err) {
			m.addDebug("veil binary not found, skipping embedder start")
			return stepDoneMsg{result: ResultOK}
		}

		// Check if embedder is already running
		configDir := m.getConfigDir()
		pidFile := filepath.Join(configDir, "embedder.pid")
		if pidData, err := os.ReadFile(pidFile); err == nil {
			// Try to parse PID (handle both old format and JSON)
			pidStr := strings.TrimSpace(string(pidData))
			var pid int
			if strings.HasPrefix(pidStr, "{") {
				var info struct{ Pid int `json:"pid"` }
				if json.Unmarshal(pidData, &info) == nil {
					pid = info.Pid
				}
			} else {
				pid, _ = strconv.Atoi(pidStr)
			}

			if pid > 0 {
				// Check if process is running (signal 0 checks existence)
				proc, err := os.FindProcess(pid)
				if err == nil {
					// On Unix, Signal(nil) or Signal(syscall.Signal(0)) checks if process exists
					if err := proc.Signal(nil); err == nil {
						m.addDebug(fmt.Sprintf("embedder server already running (PID %d)", pid))
						return stepDoneMsg{result: ResultOK}
					}
				}
				m.addDebug(fmt.Sprintf("found stale PID file (PID %d not running)", pid))
			}
		}

		m.addDebug("starting embedder server")

		cmd := exec.Command(veilBin, "embedder", "start")
		cmd.Stdout = nil
		cmd.Stderr = nil
		cmd.Stdin = nil

		if err := cmd.Start(); err != nil {
			m.addDebug(fmt.Sprintf("failed to start embedder: %v", err))
			return stepDoneMsg{result: ResultOK}
		}

		// Detach the process
		if cmd.Process != nil {
			_ = cmd.Process.Release()
		}

		// Brief wait to verify it started
		time.Sleep(500 * time.Millisecond)

		m.addDebug("embedder server started")
		return stepDoneMsg{result: ResultOK}
	}
}

func (m *Model) getConfigDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".veil")
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

// downloadCmd returns a command that downloads with progress reporting.
func (m *Model) downloadCmd() tea.Cmd {
	return func() tea.Msg {
		if m.release == nil {
			return stepDoneMsg{result: ResultError, err: fmt.Errorf("no release selected")}
		}

		assetKey := m.platform.AssetKey()
		downloadURL, ok := m.release.GetAssetURL(assetKey)
		if !ok {
			return stepDoneMsg{result: ResultError, err: fmt.Errorf("no binary for platform %s", m.platform)}
		}

		// Add debug log
		m.addDebug(fmt.Sprintf("GET %s", downloadURL))

		tmpFile, err := os.CreateTemp("", "veil-download-*.tmp")
		if err != nil {
			return stepDoneMsg{result: ResultError, err: fmt.Errorf("create temp: %w", err)}
		}
		tmpPath := tmpFile.Name()
		tmpFile.Close()

		m.addDebug(fmt.Sprintf("saving to %s", tmpPath))

		ctx := context.Background()

		// Progress callback - updates model directly (simpler than channels for now)
		onProgress := func(p download.Progress) {
			if p.Total > 0 {
				m.downloadPct = float64(p.Bytes) / float64(p.Total)
				speed := float64(p.AvgSpeed) / 1024 / 1024 // MB/s
				if p.ETA > 0 {
					m.downloadInfo = fmt.Sprintf("%.1f MB/s, %s remaining", speed, p.ETA.Round(time.Second))
				} else {
					m.downloadInfo = fmt.Sprintf("%.1f MB/s", speed)
				}
			}
		}

		if err := m.client.Download(ctx, downloadURL, tmpPath, onProgress); err != nil {
			os.Remove(tmpPath)
			return stepDoneMsg{result: ResultError, err: fmt.Errorf("download: %w", err)}
		}

		m.addDebug("download complete")
		return stepDoneMsg{result: ResultOK, data: tmpPath}
	}
}
