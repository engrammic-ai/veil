package exitcodes_test

import (
	"errors"
	"os"
	"os/exec"
	"strings"
	"testing"

	"github.com/engrammic-ai/veil-installer/internal/exitcodes"
)

// TestConstants verifies the declared exit code values match the spec.
func TestConstants(t *testing.T) {
	cases := []struct {
		name string
		got  int
		want int
	}{
		{"OK", exitcodes.OK, 0},
		{"ErrGeneral", exitcodes.ErrGeneral, 1},
		{"ErrNetwork", exitcodes.ErrNetwork, 2},
		{"ErrVerification", exitcodes.ErrVerification, 3},
		{"ErrPermission", exitcodes.ErrPermission, 4},
		{"ErrNotInstalled", exitcodes.ErrNotInstalled, 5},
		{"ErrAlreadyInstalled", exitcodes.ErrAlreadyInstalled, 6},
		{"ErrUserCancelled", exitcodes.ErrUserCancelled, 130},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if tc.got != tc.want {
				t.Errorf("%s = %d, want %d", tc.name, tc.got, tc.want)
			}
		})
	}
}

// subprocessHelper is called when TEST_SUBPROCESS is set so the test binary
// acts as the process-under-test instead of running normal tests.
func init() {
	// Only activate when the test binary is invoked as a subprocess helper.
	if os.Getenv("TEST_SUBPROCESS") == "" {
		return
	}

	switch os.Getenv("TEST_SUBPROCESS") {
	case "exit_msg":
		exitcodes.Exit(exitcodes.ErrGeneral, "something went wrong")
	case "exit_empty":
		exitcodes.Exit(exitcodes.ErrPermission, "")
	case "exit_error":
		exitcodes.ExitError(exitcodes.ErrNetwork, errors.New("connection refused"))
	case "exit_error_nil":
		exitcodes.ExitError(exitcodes.ErrGeneral, nil)
	}
}

// runSubprocess re-invokes the test binary as a subprocess helper and returns
// the exit code, combined stderr output, and any exec error.
func runSubprocess(t *testing.T, mode string) (exitCode int, stderr string, err error) {
	t.Helper()
	cmd := exec.Command(os.Args[0], "-test.run=TestMain_Subprocess")
	cmd.Env = append(os.Environ(), "TEST_SUBPROCESS="+mode)
	out, execErr := cmd.CombinedOutput()
	stderr = string(out)
	if execErr == nil {
		return 0, stderr, nil
	}
	var exitErr *exec.ExitError
	if errors.As(execErr, &exitErr) {
		return exitErr.ExitCode(), stderr, nil
	}
	return -1, stderr, execErr
}

// TestMain_Subprocess is the test entry point for subprocess mode.
// When TEST_SUBPROCESS is set the init() above will call os.Exit before any
// test function body runs, so this function body is never reached in that mode.
func TestMain_Subprocess(t *testing.T) {}

// TestExit_WritesMessageAndExitsWithCode verifies that Exit prints a message
// to stderr and terminates with the expected code.
func TestExit_WritesMessageAndExitsWithCode(t *testing.T) {
	code, stderr, err := runSubprocess(t, "exit_msg")
	if err != nil {
		t.Fatalf("subprocess error: %v", err)
	}
	if code != exitcodes.ErrGeneral {
		t.Errorf("exit code = %d, want %d", code, exitcodes.ErrGeneral)
	}
	if !strings.Contains(stderr, "something went wrong") {
		t.Errorf("stderr %q does not contain expected message", stderr)
	}
}

// TestExit_EmptyMessageDoesNotPrintNewline verifies that an empty message
// produces no output on stderr.
func TestExit_EmptyMessage(t *testing.T) {
	code, stderr, err := runSubprocess(t, "exit_empty")
	if err != nil {
		t.Fatalf("subprocess error: %v", err)
	}
	if code != exitcodes.ErrPermission {
		t.Errorf("exit code = %d, want %d", code, exitcodes.ErrPermission)
	}
	if strings.TrimSpace(stderr) != "" {
		t.Errorf("expected empty stderr, got %q", stderr)
	}
}

// TestExitError_WritesErrorAndExitsWithCode verifies that ExitError prints
// the error message to stderr and exits with the expected code.
func TestExitError_WritesErrorAndExitsWithCode(t *testing.T) {
	code, stderr, err := runSubprocess(t, "exit_error")
	if err != nil {
		t.Fatalf("subprocess error: %v", err)
	}
	if code != exitcodes.ErrNetwork {
		t.Errorf("exit code = %d, want %d", code, exitcodes.ErrNetwork)
	}
	if !strings.Contains(stderr, "connection refused") {
		t.Errorf("stderr %q does not contain expected message", stderr)
	}
}

// TestExitError_NilError verifies that a nil error produces no output.
func TestExitError_NilError(t *testing.T) {
	code, stderr, err := runSubprocess(t, "exit_error_nil")
	if err != nil {
		t.Fatalf("subprocess error: %v", err)
	}
	if code != exitcodes.ErrGeneral {
		t.Errorf("exit code = %d, want %d", code, exitcodes.ErrGeneral)
	}
	if strings.TrimSpace(stderr) != "" {
		t.Errorf("expected empty stderr for nil error, got %q", stderr)
	}
}
