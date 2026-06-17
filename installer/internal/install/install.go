package install

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// Install atomically writes the contents of src to destPath.
// It writes to a temp file first, sets permissions, then renames.
func Install(src io.Reader, destPath string) error {
	if err := ValidateInstallPath(destPath); err != nil {
		return err
	}

	dir := filepath.Dir(destPath)
	tmp, err := os.CreateTemp(dir, ".veil-install-*.tmp")
	if err != nil {
		return fmt.Errorf("create temp file: %w", err)
	}
	tmpPath := tmp.Name()

	if _, err := io.Copy(tmp, src); err != nil {
		tmp.Close()
		os.Remove(tmpPath)
		return fmt.Errorf("write binary: %w", err)
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("close temp file: %w", err)
	}

	if err := SetPermissions(tmpPath, 0o755); err != nil {
		os.Remove(tmpPath)
		return err
	}

	if err := os.Rename(tmpPath, destPath); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("rename to final path: %w", err)
	}

	return nil
}

// SetPermissions sets the file mode on path.
func SetPermissions(path string, mode os.FileMode) error {
	if err := os.Chmod(path, mode); err != nil {
		return fmt.Errorf("set permissions on %s: %w", path, err)
	}
	return nil
}

// ValidateInstallPath checks that the destination directory exists and is writable.
func ValidateInstallPath(path string) error {
	dir := filepath.Dir(path)
	info, err := os.Stat(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("install directory does not exist: %s", dir)
		}
		return fmt.Errorf("stat install directory: %w", err)
	}
	if !info.IsDir() {
		return fmt.Errorf("install path parent is not a directory: %s", dir)
	}

	// Probe writability with a temp file.
	probe, err := os.CreateTemp(dir, ".veil-probe-*.tmp")
	if err != nil {
		return fmt.Errorf("install directory not writable: %w", err)
	}
	probe.Close()
	os.Remove(probe.Name())
	return nil
}
