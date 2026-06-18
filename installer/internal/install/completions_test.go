package install

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeRunner replaces runCompletion for tests.
func withFakeRunner(output []byte, err error) func() {
	orig := runCompletion
	runCompletion = func(_, _ string) ([]byte, error) { return output, err }
	return func() { runCompletion = orig }
}

// TestGetCompletionPath_KnownShells verifies that all supported shells return
// a non-empty, expanded path.
func TestGetCompletionPath_KnownShells(t *testing.T) {
	for shell := range CompletionPaths {
		p := GetCompletionPath(shell)
		if p == "" {
			t.Errorf("GetCompletionPath(%q) returned empty string", shell)
		}
		if strings.HasPrefix(p, "~") {
			t.Errorf("GetCompletionPath(%q) returned unexpanded path: %s", shell, p)
		}
	}
}

// TestGetCompletionPath_UnknownShell verifies that an unrecognised shell
// returns an empty string.
func TestGetCompletionPath_UnknownShell(t *testing.T) {
	if p := GetCompletionPath("nushell"); p != "" {
		t.Errorf("expected empty path for unknown shell, got %q", p)
	}
}

// TestGetCompletionPath_CaseInsensitive verifies that the shell name is
// normalised to lowercase before lookup.
func TestGetCompletionPath_CaseInsensitive(t *testing.T) {
	p1 := GetCompletionPath("bash")
	p2 := GetCompletionPath("BASH")
	if p1 != p2 {
		t.Errorf("case mismatch: %q vs %q", p1, p2)
	}
}

// TestInstallCompletions_WritesFile verifies that a completion file is written
// to the expected location when the runner succeeds.
func TestInstallCompletions_WritesFile(t *testing.T) {
	dir := t.TempDir()
	content := []byte("# bash completions\ncomplete -F _veil veil\n")
	defer withFakeRunner(content, nil)()

	// Override the path for bash to point into the temp dir.
	orig := CompletionPaths["bash"]
	CompletionPaths["bash"] = filepath.Join(dir, "completions", "veil")
	defer func() { CompletionPaths["bash"] = orig }()

	if err := InstallCompletions("/usr/local/bin/veil", "bash"); err != nil {
		t.Fatalf("InstallCompletions: %v", err)
	}

	got, err := os.ReadFile(filepath.Join(dir, "completions", "veil"))
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if string(got) != string(content) {
		t.Errorf("content mismatch: got %q, want %q", got, content)
	}
}

// TestInstallCompletions_CreatesDirectory verifies that missing parent
// directories are created automatically.
func TestInstallCompletions_CreatesDirectory(t *testing.T) {
	dir := t.TempDir()
	defer withFakeRunner([]byte("# completions"), nil)()

	origConfigure := configureZshFpathFn
	configureZshFpathFn = func(rcPath string) error { return nil }
	defer func() { configureZshFpathFn = origConfigure }()

	nested := filepath.Join(dir, "a", "b", "c", "_veil")
	orig := CompletionPaths["zsh"]
	CompletionPaths["zsh"] = nested
	defer func() { CompletionPaths["zsh"] = orig }()

	if err := InstallCompletions("/usr/bin/veil", "zsh"); err != nil {
		t.Fatalf("InstallCompletions: %v", err)
	}

	if _, err := os.Stat(nested); err != nil {
		t.Errorf("completion file not created: %v", err)
	}
}

// TestInstallCompletions_UnknownShell verifies that an error is returned for
// an unrecognised shell name.
func TestInstallCompletions_UnknownShell(t *testing.T) {
	err := InstallCompletions("/usr/bin/veil", "tcsh")
	if err == nil {
		t.Error("expected error for unknown shell, got nil")
	}
}

// TestInstallCompletions_RunnerError propagates the runner error to the caller.
func TestInstallCompletions_RunnerError(t *testing.T) {
	dir := t.TempDir()
	defer withFakeRunner(nil, errors.New("binary not found"))()

	orig := CompletionPaths["fish"]
	CompletionPaths["fish"] = filepath.Join(dir, "veil.fish")
	defer func() { CompletionPaths["fish"] = orig }()

	err := InstallCompletions("/usr/bin/veil", "fish")
	if err == nil {
		t.Error("expected error when runner fails, got nil")
	}
}

// TestRemoveCompletions_RemovesFile verifies that RemoveCompletions deletes the
// completion file.
func TestRemoveCompletions_RemovesFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "veil.fish")
	if err := os.WriteFile(path, []byte("# fish completions"), 0o644); err != nil {
		t.Fatal(err)
	}

	orig := CompletionPaths["fish"]
	CompletionPaths["fish"] = path
	defer func() { CompletionPaths["fish"] = orig }()

	if err := RemoveCompletions("fish"); err != nil {
		t.Fatalf("RemoveCompletions: %v", err)
	}

	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Errorf("expected file to be removed")
	}
}

// TestRemoveCompletions_MissingFileIsNoOp verifies that removing a
// non-existent file is not an error.
func TestRemoveCompletions_MissingFileIsNoOp(t *testing.T) {
	dir := t.TempDir()
	orig := CompletionPaths["bash"]
	CompletionPaths["bash"] = filepath.Join(dir, "nonexistent", "veil")
	defer func() { CompletionPaths["bash"] = orig }()

	if err := RemoveCompletions("bash"); err != nil {
		t.Errorf("expected nil for missing file, got: %v", err)
	}
}

// TestRemoveCompletions_UnknownShell verifies that an error is returned for
// an unrecognised shell name.
func TestRemoveCompletions_UnknownShell(t *testing.T) {
	if err := RemoveCompletions("tcsh"); err == nil {
		t.Error("expected error for unknown shell, got nil")
	}
}
