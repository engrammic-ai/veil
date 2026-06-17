package install

import (
	"fmt"
	"os"
	"path/filepath"
)

// RollbackInfo describes what a rollback will do.
type RollbackInfo struct {
	CurrentVersion string
	BackupVersion  string
	BackupPath     string
}

// GetRollbackInfo inspects the installed binary and most-recent backup to
// describe what a rollback would do. Returns an error if no backup exists.
func GetRollbackInfo(installPath, backupDir string) (*RollbackInfo, error) {
	backups, err := ListBackups(backupDir)
	if err != nil {
		return nil, fmt.Errorf("list backups: %w", err)
	}
	if len(backups) == 0 {
		return nil, fmt.Errorf("no backup found in %s", backupDir)
	}

	latest := backups[0]

	// Read version from the installed binary name if a version tag file exists,
	// otherwise fall back to the second backup's version or "unknown".
	currentVersion := "unknown"
	if len(backups) > 1 {
		// The second-newest backup corresponds to what was installed before the
		// most recent upgrade, not the current binary. Use the backup version as
		// the best available label for the current install.
		currentVersion = backups[1].Version
	}
	// If a .veil-version file lives next to the binary, prefer that.
	versionFile := filepath.Join(filepath.Dir(installPath), ".veil-version")
	if data, err := os.ReadFile(versionFile); err == nil && len(data) > 0 {
		currentVersion = string(data)
	}

	return &RollbackInfo{
		CurrentVersion: currentVersion,
		BackupVersion:  latest.Version,
		BackupPath:     latest.Path,
	}, nil
}

// Rollback replaces the installed binary with the most-recent backup.
// Before restoring, it backs up the current binary as "rollback-target" so the
// swap is reversible.
func Rollback(installPath, backupDir string) error {
	info, err := GetRollbackInfo(installPath, backupDir)
	if err != nil {
		return err
	}

	// Save current binary before overwriting so the rollback itself is undoable.
	if _, statErr := os.Stat(installPath); statErr == nil {
		if _, backupErr := Backup(installPath, backupDir, info.CurrentVersion+"-rollback-target"); backupErr != nil {
			return fmt.Errorf("back up current binary before rollback: %w", backupErr)
		}
	}

	if err := Restore(info.BackupPath, installPath); err != nil {
		return fmt.Errorf("restore backup: %w", err)
	}

	return nil
}
