package install

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// BackupInfo describes a stored backup.
type BackupInfo struct {
	Path    string
	Version string
	// CreatedAt is derived from the file's mtime, not stored separately.
	CreatedAt time.Time
}

// Backup copies srcPath to backupDir/veil-<version>.bak.
// Returns the backup path on success.
func Backup(srcPath, backupDir, version string) (string, error) {
	if err := os.MkdirAll(backupDir, 0o700); err != nil {
		return "", fmt.Errorf("create backup dir: %w", err)
	}

	backupPath := filepath.Join(backupDir, fmt.Sprintf("veil-%s.bak", version))

	src, err := os.Open(srcPath)
	if err != nil {
		return "", fmt.Errorf("open source binary: %w", err)
	}
	defer src.Close()

	tmp := backupPath + ".tmp"
	dst, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o700)
	if err != nil {
		return "", fmt.Errorf("create backup temp file: %w", err)
	}

	if _, err := copyFile(src, dst); err != nil {
		dst.Close()
		os.Remove(tmp)
		return "", fmt.Errorf("copy to backup: %w", err)
	}
	if err := dst.Close(); err != nil {
		os.Remove(tmp)
		return "", fmt.Errorf("close backup file: %w", err)
	}

	if err := os.Rename(tmp, backupPath); err != nil {
		os.Remove(tmp)
		return "", fmt.Errorf("commit backup: %w", err)
	}

	return backupPath, nil
}

// Restore copies backupPath back to destPath atomically.
func Restore(backupPath, destPath string) error {
	src, err := os.Open(backupPath)
	if err != nil {
		return fmt.Errorf("open backup: %w", err)
	}
	defer src.Close()

	return Install(src, destPath)
}

// ListBackups returns all backups in backupDir, newest first.
func ListBackups(backupDir string) ([]BackupInfo, error) {
	entries, err := os.ReadDir(backupDir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("read backup dir: %w", err)
	}

	var backups []BackupInfo
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".bak") {
			continue
		}
		name := strings.TrimSuffix(e.Name(), ".bak")
		// Expected: veil-<version>
		version := strings.TrimPrefix(name, "veil-")

		info, err := e.Info()
		if err != nil {
			continue
		}
		backups = append(backups, BackupInfo{
			Path:      filepath.Join(backupDir, e.Name()),
			Version:   version,
			CreatedAt: info.ModTime(),
		})
	}

	sort.Slice(backups, func(i, j int) bool {
		return backups[i].CreatedAt.After(backups[j].CreatedAt)
	})

	return backups, nil
}

// copyFile copies from src to dst and returns bytes written.
func copyFile(src *os.File, dst *os.File) (int64, error) {
	n, err := dst.ReadFrom(src)
	if err != nil {
		return n, err
	}
	return n, nil
}
