package platform

import (
	"os"
	"path/filepath"
	"strings"
)

// ShellConfig holds per-shell RC file and PATH export snippet.
type ShellConfig struct {
	Shell  string
	RCFile string
	Export string
}

var shellConfigs = map[string]ShellConfig{
	"bash": {
		Shell:  "bash",
		RCFile: "~/.bashrc",
		Export: `export PATH="$HOME/.local/bin:$PATH"`,
	},
	"zsh": {
		Shell:  "zsh",
		RCFile: "~/.zshrc",
		Export: `export PATH="$HOME/.local/bin:$PATH"`,
	},
	"fish": {
		Shell:  "fish",
		RCFile: "~/.config/fish/config.fish",
		Export: `fish_add_path ~/.local/bin`,
	},
	"powershell": {
		Shell:  "powershell",
		RCFile: "$PROFILE",
		Export: `$env:PATH = "$env:LOCALAPPDATA\veil;$env:PATH"`,
	},
	"nushell": {
		Shell:  "nushell",
		RCFile: "~/.config/nushell/config.nu",
		Export: `$env.PATH = ($env.PATH | prepend "~/.local/bin")`,
	},
}

// DetectShell returns the name of the current shell (e.g. "bash", "zsh").
// It checks $SHELL first, then falls back to "bash".
func DetectShell() string {
	shell := os.Getenv("SHELL")
	if shell != "" {
		base := filepath.Base(shell)
		base = strings.ToLower(base)
		if _, ok := shellConfigs[base]; ok {
			return base
		}
	}

	// Check $0 as a secondary signal (set by some shells).
	if s := os.Getenv("0"); s != "" {
		base := strings.TrimPrefix(filepath.Base(s), "-")
		base = strings.ToLower(base)
		if _, ok := shellConfigs[base]; ok {
			return base
		}
	}

	return "bash"
}

// GetShellConfig returns the ShellConfig for the named shell.
// If the shell is not recognised, the bash config is returned.
func GetShellConfig(shell string) ShellConfig {
	if cfg, ok := shellConfigs[strings.ToLower(shell)]; ok {
		return cfg
	}
	return shellConfigs["bash"]
}
