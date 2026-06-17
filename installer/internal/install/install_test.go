package install

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

// ---- helpers ----------------------------------------------------------------

func makeDir(t *testing.T) string {
	t.Helper()
	d := t.TempDir()
	return d
}

// ---- Install ----------------------------------------------------------------

func TestInstall_WritesContent(t *testing.T) {
	dir := makeDir(t)
	dest := filepath.Join(dir, "veil")
	content := []byte("binary content")

	if err := Install(bytes.NewReader(content), dest); err != nil {
		t.Fatalf("Install: %v", err)
	}

	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if !bytes.Equal(got, content) {
		t.Errorf("content mismatch: got %q want %q", got, content)
	}
}

func TestInstall_SetsExecutable(t *testing.T) {
	dir := makeDir(t)
	dest := filepath.Join(dir, "veil")

	if err := Install(bytes.NewReader([]byte("x")), dest); err != nil {
		t.Fatalf("Install: %v", err)
	}

	info, err := os.Stat(dest)
	if err != nil {
		t.Fatalf("Stat: %v", err)
	}
	if info.Mode()&0o111 == 0 {
		t.Errorf("binary is not executable: mode %v", info.Mode())
	}
}

func TestInstall_InvalidDir(t *testing.T) {
	err := Install(bytes.NewReader([]byte("x")), "/nonexistent/dir/veil")
	if err == nil {
		t.Error("expected error for non-existent directory, got nil")
	}
}

// ---- ValidateInstallPath ----------------------------------------------------

func TestValidateInstallPath_OK(t *testing.T) {
	dir := makeDir(t)
	if err := ValidateInstallPath(filepath.Join(dir, "veil")); err != nil {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestValidateInstallPath_MissingDir(t *testing.T) {
	err := ValidateInstallPath("/this/does/not/exist/veil")
	if err == nil {
		t.Error("expected error for missing directory")
	}
}

// ---- SetPermissions ---------------------------------------------------------

func TestSetPermissions(t *testing.T) {
	dir := makeDir(t)
	f, _ := os.CreateTemp(dir, "perm-*")
	f.Close()

	if err := SetPermissions(f.Name(), 0o755); err != nil {
		t.Fatalf("SetPermissions: %v", err)
	}
	info, _ := os.Stat(f.Name())
	if info.Mode().Perm() != 0o755 {
		t.Errorf("mode = %v, want 0755", info.Mode().Perm())
	}
}

// ---- Backup -----------------------------------------------------------------

func TestBackup_CreatesFile(t *testing.T) {
	dir := makeDir(t)
	src := filepath.Join(dir, "veil")
	if err := os.WriteFile(src, []byte("v1"), 0o755); err != nil {
		t.Fatal(err)
	}

	backupDir := filepath.Join(dir, "backups")
	path, err := Backup(src, backupDir, "1.0.0")
	if err != nil {
		t.Fatalf("Backup: %v", err)
	}

	if _, err := os.Stat(path); err != nil {
		t.Errorf("backup file missing: %v", err)
	}
}

func TestBackup_ContentMatchesSource(t *testing.T) {
	dir := makeDir(t)
	content := []byte("binary v2")
	src := filepath.Join(dir, "veil")
	os.WriteFile(src, content, 0o755)

	backupDir := filepath.Join(dir, "backups")
	path, _ := Backup(src, backupDir, "2.0.0")

	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if !bytes.Equal(got, content) {
		t.Errorf("backup content mismatch")
	}
}

func TestBackup_MissingSource(t *testing.T) {
	dir := makeDir(t)
	_, err := Backup(filepath.Join(dir, "nonexistent"), filepath.Join(dir, "backups"), "1.0.0")
	if err == nil {
		t.Error("expected error for missing source")
	}
}

// ---- Restore ----------------------------------------------------------------

func TestRestore_RestoresContent(t *testing.T) {
	dir := makeDir(t)
	content := []byte("old binary")
	backup := filepath.Join(dir, "veil-1.0.0.bak")
	os.WriteFile(backup, content, 0o755)

	dest := filepath.Join(dir, "veil")
	if err := Restore(backup, dest); err != nil {
		t.Fatalf("Restore: %v", err)
	}

	got, _ := os.ReadFile(dest)
	if !bytes.Equal(got, content) {
		t.Errorf("restored content mismatch")
	}
}

// ---- ListBackups ------------------------------------------------------------

func TestListBackups_Empty(t *testing.T) {
	dir := makeDir(t)
	backups, err := ListBackups(dir)
	if err != nil {
		t.Fatalf("ListBackups: %v", err)
	}
	if len(backups) != 0 {
		t.Errorf("expected 0 backups, got %d", len(backups))
	}
}

func TestListBackups_NonExistentDir(t *testing.T) {
	backups, err := ListBackups("/nonexistent/path")
	if err != nil {
		t.Fatalf("expected nil error for missing dir, got: %v", err)
	}
	if backups != nil {
		t.Errorf("expected nil slice for missing dir")
	}
}

func TestListBackups_ReturnsSortedNewestFirst(t *testing.T) {
	dir := makeDir(t)

	for _, v := range []string{"1.0.0", "2.0.0", "3.0.0"} {
		src := filepath.Join(dir, "src")
		os.WriteFile(src, []byte(v), 0o755)
		Backup(src, dir, v)
	}

	backups, err := ListBackups(dir)
	if err != nil {
		t.Fatalf("ListBackups: %v", err)
	}
	if len(backups) != 3 {
		t.Fatalf("expected 3 backups, got %d", len(backups))
	}
	// Newest should be first; verify version order if mtimes differ.
	for i := 1; i < len(backups); i++ {
		if backups[i].CreatedAt.After(backups[i-1].CreatedAt) {
			t.Errorf("backups not sorted newest first at index %d", i)
		}
	}
}

// ---- GetRollbackInfo --------------------------------------------------------

func TestGetRollbackInfo_NoBackup(t *testing.T) {
	dir := makeDir(t)
	_, err := GetRollbackInfo(filepath.Join(dir, "veil"), filepath.Join(dir, "backups"))
	if err == nil {
		t.Error("expected error when no backup exists")
	}
}

func TestGetRollbackInfo_ReturnsLatest(t *testing.T) {
	dir := makeDir(t)
	backupDir := filepath.Join(dir, "backups")
	src := filepath.Join(dir, "veil")
	os.WriteFile(src, []byte("v1"), 0o755)
	Backup(src, backupDir, "1.2.3")

	info, err := GetRollbackInfo(src, backupDir)
	if err != nil {
		t.Fatalf("GetRollbackInfo: %v", err)
	}
	if info.BackupVersion != "1.2.3" {
		t.Errorf("BackupVersion = %q, want 1.2.3", info.BackupVersion)
	}
}

// ---- Rollback ---------------------------------------------------------------

func TestRollback_RestoresPreviousBinary(t *testing.T) {
	dir := makeDir(t)
	backupDir := filepath.Join(dir, "backups")

	// Install v1 and back it up.
	install := filepath.Join(dir, "veil")
	os.WriteFile(install, []byte("v1 binary"), 0o755)
	Backup(install, backupDir, "1.0.0")

	// Upgrade to v2.
	os.WriteFile(install, []byte("v2 binary"), 0o755)

	if err := Rollback(install, backupDir); err != nil {
		t.Fatalf("Rollback: %v", err)
	}

	got, _ := os.ReadFile(install)
	if !bytes.Equal(got, []byte("v1 binary")) {
		t.Errorf("after rollback got %q, want v1 binary", got)
	}
}

func TestRollback_NoBackup(t *testing.T) {
	dir := makeDir(t)
	err := Rollback(filepath.Join(dir, "veil"), filepath.Join(dir, "backups"))
	if err == nil {
		t.Error("expected error when no backup exists")
	}
}
