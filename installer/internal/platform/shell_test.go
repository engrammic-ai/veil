package platform

import (
	"os"
	"testing"
)

func TestGetShellConfig_KnownShells(t *testing.T) {
	cases := []struct {
		shell      string
		wantShell  string
		wantRCFile string
	}{
		{"bash", "bash", "~/.bashrc"},
		{"zsh", "zsh", "~/.zshrc"},
		{"fish", "fish", "~/.config/fish/config.fish"},
		{"powershell", "powershell", "$PROFILE"},
		{"nushell", "nushell", "~/.config/nushell/config.nu"},
	}
	for _, c := range cases {
		cfg := GetShellConfig(c.shell)
		if cfg.Shell != c.wantShell {
			t.Errorf("GetShellConfig(%q).Shell = %q, want %q", c.shell, cfg.Shell, c.wantShell)
		}
		if cfg.RCFile != c.wantRCFile {
			t.Errorf("GetShellConfig(%q).RCFile = %q, want %q", c.shell, cfg.RCFile, c.wantRCFile)
		}
		if cfg.Export == "" {
			t.Errorf("GetShellConfig(%q).Export is empty", c.shell)
		}
	}
}

func TestGetShellConfig_UnknownFallsToBash(t *testing.T) {
	cfg := GetShellConfig("tcsh")
	if cfg.Shell != "bash" {
		t.Errorf("GetShellConfig(unknown).Shell = %q, want bash", cfg.Shell)
	}
}

func TestGetShellConfig_CaseInsensitive(t *testing.T) {
	cfg := GetShellConfig("ZSH")
	if cfg.Shell != "zsh" {
		t.Errorf("GetShellConfig(ZSH).Shell = %q, want zsh", cfg.Shell)
	}
}

func TestDetectShell_FromEnv(t *testing.T) {
	t.Setenv("SHELL", "/bin/zsh")
	got := DetectShell()
	if got != "zsh" {
		t.Errorf("DetectShell() = %q, want zsh", got)
	}
}

func TestDetectShell_UnknownShellFallsToBash(t *testing.T) {
	os.Unsetenv("SHELL")
	os.Unsetenv("0")
	got := DetectShell()
	if got != "bash" {
		t.Errorf("DetectShell() with no SHELL = %q, want bash", got)
	}
}

func TestDetectShell_ReturnsValidShell(t *testing.T) {
	shell := DetectShell()
	cfg := GetShellConfig(shell)
	if cfg.Shell == "" {
		t.Errorf("DetectShell() returned %q which has no config", shell)
	}
}
