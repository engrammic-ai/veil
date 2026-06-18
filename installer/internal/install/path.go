package install

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/engrammic-ai/veil-installer/internal/platform"
)

const pathMarker = "# Added by veil-installer"

// ModifyPATH appends the shell's PATH export to its RC file, guarded by a
// marker comment. It is a no-op if the marker is already present.
func ModifyPATH(shell platform.ShellConfig, installDir string) error {
	rc, err := expandPath(shell.RCFile)
	if err != nil {
		return fmt.Errorf("expand RC path: %w", err)
	}

	if IsPathConfigured(shell) {
		return nil
	}

	export := shell.Export
	if installDir != "" {
		export = buildExport(shell, installDir)
	}

	block := "\n" + pathMarker + "\n" + export + "\n"
	return atomicAppend(rc, []byte(block))
}

// IsPathConfigured reports whether the shell RC file already contains the
// veil-installer marker.
func IsPathConfigured(shell platform.ShellConfig) bool {
	rc, err := expandPath(shell.RCFile)
	if err != nil {
		return false
	}

	data, err := os.ReadFile(rc)
	if err != nil {
		return false
	}

	return strings.Contains(string(data), pathMarker)
}

// atomicAppend appends data to path by writing a temp file alongside it and
// renaming into place.
func atomicAppend(path string, data []byte) error {
	// Read existing content.
	existing, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("read RC file: %w", err)
	}

	combined := append(existing, data...)

	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("create RC directory: %w", err)
	}

	tmp, err := os.CreateTemp(dir, ".veil-path-*.tmp")
	if err != nil {
		return fmt.Errorf("create temp file: %w", err)
	}
	tmpPath := tmp.Name()

	if _, err := tmp.Write(combined); err != nil {
		tmp.Close()
		os.Remove(tmpPath)
		return fmt.Errorf("write temp file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("close temp file: %w", err)
	}

	if err := os.Rename(tmpPath, path); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("rename to RC file: %w", err)
	}

	return nil
}

// expandPath replaces a leading ~ with the user's home directory.
func expandPath(p string) (string, error) {
	if !strings.HasPrefix(p, "~") {
		return p, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, p[1:]), nil
}

// buildExport returns a PATH export line using the provided installDir.
// For shells that use fixed snippets (fish, nushell, powershell) we return the
// default export unchanged; only POSIX shells use the installDir value.
func buildExport(shell platform.ShellConfig, installDir string) string {
	switch shell.Shell {
	case "bash", "zsh":
		return fmt.Sprintf(`export PATH="%s:$PATH"`, installDir)
	default:
		return shell.Export
	}
}

const zshFpathMarker = "# Added by veil-installer completions"

// configureZshFpath appends the zsh completion directory to fpath in the given RC file path.
// If rcPath is empty, it defaults to ~/.zshrc.
func configureZshFpath(rcPath string) error {
	if rcPath == "" {
		rcPath = "~/.zshrc"
	}
	rc, err := expandPath(rcPath)
	if err != nil {
		return fmt.Errorf("expand RC path: %w", err)
	}

	data, err := os.ReadFile(rc)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("read RC file: %w", err)
	}

	if strings.Contains(string(data), zshFpathMarker) {
		return nil
	}

	block := "\n" + zshFpathMarker + "\n" + `fpath=("$HOME/.local/share/zsh/site-functions" $fpath)` + "\n"
	return atomicAppend(rc, []byte(block))
}
