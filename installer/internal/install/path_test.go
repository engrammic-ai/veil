package install

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/engrammic-ai/veil-installer/internal/platform"
)

func shellWithRC(t *testing.T, rcFile string) platform.ShellConfig {
	t.Helper()
	return platform.ShellConfig{
		Shell:  "bash",
		RCFile: rcFile,
		Export: `export PATH="$HOME/.local/bin:$PATH"`,
	}
}

// TestModifyPATH_AppendsMarkerAndExport verifies that ModifyPATH writes the
// marker comment and export line to a new RC file.
func TestModifyPATH_AppendsMarkerAndExport(t *testing.T) {
	dir := t.TempDir()
	rc := filepath.Join(dir, ".bashrc")

	shell := shellWithRC(t, rc)
	if err := ModifyPATH(shell, ""); err != nil {
		t.Fatalf("ModifyPATH: %v", err)
	}

	data, err := os.ReadFile(rc)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	content := string(data)
	if !strings.Contains(content, pathMarker) {
		t.Errorf("RC file missing marker; got:\n%s", content)
	}
	if !strings.Contains(content, shell.Export) {
		t.Errorf("RC file missing export line; got:\n%s", content)
	}
}

// TestModifyPATH_IdempotentWhenMarkerPresent verifies that a second call does
// not append a duplicate block.
func TestModifyPATH_IdempotentWhenMarkerPresent(t *testing.T) {
	dir := t.TempDir()
	rc := filepath.Join(dir, ".bashrc")

	shell := shellWithRC(t, rc)

	for i := 0; i < 2; i++ {
		if err := ModifyPATH(shell, ""); err != nil {
			t.Fatalf("ModifyPATH call %d: %v", i+1, err)
		}
	}

	data, _ := os.ReadFile(rc)
	count := strings.Count(string(data), pathMarker)
	if count != 1 {
		t.Errorf("marker appears %d times, want 1:\n%s", count, string(data))
	}
}

// TestModifyPATH_PreservesExistingContent ensures existing RC content is kept.
func TestModifyPATH_PreservesExistingContent(t *testing.T) {
	dir := t.TempDir()
	rc := filepath.Join(dir, ".bashrc")
	existing := "# existing config\nalias ll='ls -la'\n"
	os.WriteFile(rc, []byte(existing), 0o644)

	shell := shellWithRC(t, rc)
	if err := ModifyPATH(shell, ""); err != nil {
		t.Fatalf("ModifyPATH: %v", err)
	}

	data, _ := os.ReadFile(rc)
	if !strings.HasPrefix(string(data), existing) {
		t.Errorf("existing content was not preserved; got:\n%s", string(data))
	}
}

// TestModifyPATH_UsesInstallDirForPOSIX checks that a custom installDir is
// substituted for bash/zsh shells.
func TestModifyPATH_UsesInstallDirForPOSIX(t *testing.T) {
	dir := t.TempDir()
	rc := filepath.Join(dir, ".bashrc")
	installDir := "/opt/veil/bin"

	shell := shellWithRC(t, rc)
	if err := ModifyPATH(shell, installDir); err != nil {
		t.Fatalf("ModifyPATH: %v", err)
	}

	data, _ := os.ReadFile(rc)
	if !strings.Contains(string(data), installDir) {
		t.Errorf("installDir %q not found in RC file:\n%s", installDir, string(data))
	}
}

// TestIsPathConfigured_FalseWhenAbsent checks detection when no marker exists.
func TestIsPathConfigured_FalseWhenAbsent(t *testing.T) {
	dir := t.TempDir()
	rc := filepath.Join(dir, ".bashrc")
	os.WriteFile(rc, []byte("# plain config\n"), 0o644)

	shell := shellWithRC(t, rc)
	if IsPathConfigured(shell) {
		t.Error("IsPathConfigured returned true for file without marker")
	}
}

// TestIsPathConfigured_TrueWhenPresent checks detection after ModifyPATH.
func TestIsPathConfigured_TrueWhenPresent(t *testing.T) {
	dir := t.TempDir()
	rc := filepath.Join(dir, ".bashrc")

	shell := shellWithRC(t, rc)
	ModifyPATH(shell, "")

	if !IsPathConfigured(shell) {
		t.Error("IsPathConfigured returned false after ModifyPATH")
	}
}

// TestIsPathConfigured_FalseForMissingFile checks graceful handling of
// non-existent RC file.
func TestIsPathConfigured_FalseForMissingFile(t *testing.T) {
	shell := shellWithRC(t, "/nonexistent/path/.bashrc")
	if IsPathConfigured(shell) {
		t.Error("IsPathConfigured returned true for missing RC file")
	}
}

// TestAtomicAppend_CreatesFileInNewDir checks that atomicAppend creates
// intermediate directories.
func TestAtomicAppend_CreatesFileInNewDir(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "subdir", "config.fish")

	if err := atomicAppend(target, []byte("hello\n")); err != nil {
		t.Fatalf("atomicAppend: %v", err)
	}

	data, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if string(data) != "hello\n" {
		t.Errorf("content = %q, want 'hello\\n'", string(data))
	}
}

// TestConfigureZshFpath_AppendsFpath verifies that configureZshFpath
// correctly appends the fpath setup to the zshrc file.
func TestConfigureZshFpath_AppendsFpath(t *testing.T) {
	dir := t.TempDir()
	rc := filepath.Join(dir, ".zshrc")

	// Missing RC file should be a graceful no-op.
	if err := configureZshFpath(rc); err != nil {
		t.Fatalf("configureZshFpath on missing file: %v", err)
	}

	// Create existing content.
	existing := "alias gs='git status'\n"
	if err := os.WriteFile(rc, []byte(existing), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := configureZshFpath(rc); err != nil {
		t.Fatalf("configureZshFpath: %v", err)
	}

	data, err := os.ReadFile(rc)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	content := string(data)
	if !strings.HasPrefix(content, existing) {
		t.Errorf("existing content not preserved; got:\n%s", content)
	}
	if !strings.Contains(content, zshFpathMarker) {
		t.Errorf("missing fpath marker; got:\n%s", content)
	}
	if !strings.Contains(content, `fpath=("$HOME/.local/share/zsh/site-functions" $fpath)`) {
		t.Errorf("missing fpath config line; got:\n%s", content)
	}

	// Idempotency check.
	if err := configureZshFpath(rc); err != nil {
		t.Fatalf("configureZshFpath second call: %v", err)
	}
	data2, _ := os.ReadFile(rc)
	count := strings.Count(string(data2), zshFpathMarker)
	if count != 1 {
		t.Errorf("marker appears %d times, want 1", count)
	}
}
