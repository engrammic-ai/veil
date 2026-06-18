package app

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/charmbracelet/bubbles/spinner"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/engrammic-ai/veil-installer/internal/platform"
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
	state        State
	platform     platform.Platform
	version      string       // selected or flagged version
	embedderTier EmbedderTier // selected embedder model tier
	spinner      spinner.Model
	err          error

	// CLI flags forwarded from cobra.
	flagVersion string
	flagYes     bool

	style lipgloss.Style
}

// Options configures the Model at construction time.
type Options struct {
	Version string // --version flag value, empty if not set
	Yes     bool   // --yes flag
}

func New(opts Options) *Model {
	sp := spinner.New()
	sp.Spinner = spinner.Dot

	return &Model{
		state:        StateDetectPlatform,
		embedderTier: EmbedderBalanced, // default
		spinner:      sp,
		flagVersion:  opts.Version,
		flagYes:      opts.Yes,
		style:        lipgloss.NewStyle().Padding(1, 2),
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

	case spinner.TickMsg:
		var cmd tea.Cmd
		m.spinner, cmd = m.spinner.Update(msg)
		return m, cmd

	case stepDoneMsg:
		if msg.err != nil {
			m.err = msg.err
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
	var body string
	switch m.state {
	case StateDetectPlatform:
		body = fmt.Sprintf("%s Detecting platform...", m.spinner.View())
	case StateCheckExisting:
		body = fmt.Sprintf("%s Checking for existing installation...", m.spinner.View())
	case StatePromptUpgrade:
		body = "An existing Veil installation was found.\nPress Enter to upgrade or q to cancel."
	case StateFetchVersions:
		body = fmt.Sprintf("%s Fetching available versions...", m.spinner.View())
	case StatePromptVersion:
		body = "Select a version to install."
	case StateValidateVer:
		body = fmt.Sprintf("%s Validating version %s...", m.spinner.View(), m.flagVersion)
	case StateDownload:
		body = fmt.Sprintf("%s Downloading Veil %s...", m.spinner.View(), m.version)
	case StateVerifySum:
		body = fmt.Sprintf("%s Verifying checksum...", m.spinner.View())
	case StateVerifySig:
		body = fmt.Sprintf("%s Verifying signature...", m.spinner.View())
	case StateInstall:
		body = fmt.Sprintf("%s Installing...", m.spinner.View())
	case StateConfigurePATH:
		body = fmt.Sprintf("%s Configuring PATH...", m.spinner.View())
	case StateInstallCompletions:
		body = fmt.Sprintf("%s Installing shell completions...", m.spinner.View())
	case StatePromptEmbedder:
		body = `Semantic Memory Model:

Select an embedding model for semantic search in memory.
Models are downloaded on first use.

  ○ None       (keyword search only, 0 RAM)
  ○ Light      (23MB, ~100MB RAM, English)
  ● Balanced   (118MB, ~300MB RAM, multilingual) [recommended]
  ○ Quality    (278MB, ~600MB RAM, multilingual)
  ○ Max        (560MB, ~1.2GB RAM, multilingual)
  ○ Ollama     (requires Ollama running locally)

Use ↑/↓ to select, Enter to confirm.`
	case StateConfigureEmbedder:
		body = fmt.Sprintf("%s Configuring semantic memory...", m.spinner.View())
	case StateSuccess:
		body = "Veil installed successfully.\nRun 'pi --version' to confirm."
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

	return m.style.Render(body)
}

// runStep returns the tea.Cmd that executes work for the given state.
// Non-automated states (prompts) return nil; the Update loop handles them on
// user input.
func (m *Model) runStep(s State) tea.Cmd {
	switch s {
	case StateDetectPlatform:
		return func() tea.Msg {
			p := platform.Detect()
			switch p.OS {
			case "linux", "darwin", "windows":
				return stepDoneMsg{result: ResultOK}
			default:
				return stepDoneMsg{
					result: ResultUnsupported,
					err:    fmt.Errorf("unsupported OS: %s", p.OS),
				}
			}
		}

	case StateCheckExisting:
		// Stub: always report clean (no existing install).
		return func() tea.Msg { return stepDoneMsg{result: ResultOK} }

	case StateFetchVersions:
		if m.flagVersion != "" {
			return func() tea.Msg { return stepDoneMsg{result: ResultVersionSet} }
		}
		// Stub: signal interactive version selection.
		return func() tea.Msg { return stepDoneMsg{result: ResultOK} }

	case StateValidateVer:
		return func() tea.Msg { return stepDoneMsg{result: ResultOK} }

	case StateDownload:
		return func() tea.Msg { return stepDoneMsg{result: ResultOK} }

	case StateVerifySum:
		return func() tea.Msg { return stepDoneMsg{result: ResultOK} }

	case StateVerifySig:
		return func() tea.Msg { return stepDoneMsg{result: ResultOK} }

	case StateInstall:
		return func() tea.Msg { return stepDoneMsg{result: ResultOK} }

	case StateConfigurePATH:
		return func() tea.Msg { return stepDoneMsg{result: ResultOK} }

	case StateInstallCompletions:
		return func() tea.Msg { return stepDoneMsg{result: ResultOK} }

	case StatePromptEmbedder:
		if m.flagYes {
			// Auto-mode: use balanced (recommended)
			m.embedderTier = EmbedderBalanced
			return func() tea.Msg { return stepDoneMsg{result: ResultOK} }
		}
		// Interactive: wait for user selection
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
