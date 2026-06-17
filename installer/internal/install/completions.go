package install

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// CompletionPaths maps shell names to their default completion install paths.
// Paths may contain a leading ~ which is expanded at runtime.
var CompletionPaths = map[string]string{
	"bash":       "~/.local/share/bash-completion/completions/veil",
	"zsh":        "~/.local/share/zsh/site-functions/_veil",
	"fish":       "~/.config/fish/completions/veil.fish",
	"powershell": "~/Documents/PowerShell/Modules/veil/veil.psm1",
}

// GetCompletionPath returns the expanded completion install path for the given shell.
// Returns an empty string if the shell is not recognised.
func GetCompletionPath(shell string) string {
	raw, ok := CompletionPaths[strings.ToLower(shell)]
	if !ok {
		return ""
	}
	expanded, err := expandPath(raw)
	if err != nil {
		return raw
	}
	return expanded
}

// InstallCompletions runs `veilBinary completion <shell>` and writes the output
// to the shell's standard completion directory.
func InstallCompletions(veilBinary, shell string) error {
	shell = strings.ToLower(shell)
	destPath := GetCompletionPath(shell)
	if destPath == "" {
		return fmt.Errorf("unsupported shell for completions: %s", shell)
	}

	if err := os.MkdirAll(filepath.Dir(destPath), 0o755); err != nil {
		return fmt.Errorf("create completion directory: %w", err)
	}

	out, err := runCompletion(veilBinary, shell)
	if err != nil {
		return fmt.Errorf("generate completions: %w", err)
	}

	tmp, err := os.CreateTemp(filepath.Dir(destPath), ".veil-completion-*.tmp")
	if err != nil {
		return fmt.Errorf("create temp file: %w", err)
	}
	tmpPath := tmp.Name()

	if _, err := tmp.Write(out); err != nil {
		tmp.Close()
		os.Remove(tmpPath)
		return fmt.Errorf("write completion temp file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("close temp file: %w", err)
	}

	if err := os.Rename(tmpPath, destPath); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("install completion file: %w", err)
	}

	return nil
}

// RemoveCompletions deletes the completion file for the given shell.
// Returns nil if the file does not exist.
func RemoveCompletions(shell string) error {
	destPath := GetCompletionPath(strings.ToLower(shell))
	if destPath == "" {
		return fmt.Errorf("unsupported shell for completions: %s", shell)
	}

	if err := os.Remove(destPath); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove completion file: %w", err)
	}
	return nil
}

// runCompletion executes `veilBinary completion <shell>` and returns stdout.
// Extracted as a variable so tests can replace it.
var runCompletion = func(veilBinary, shell string) ([]byte, error) {
	if runtime.GOOS == "windows" && !strings.HasSuffix(veilBinary, ".exe") {
		veilBinary += ".exe"
	}
	cmd := exec.Command(veilBinary, "completion", shell) //nolint:gosec
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("veil completion %s: %w", shell, err)
	}
	return out, nil
}
