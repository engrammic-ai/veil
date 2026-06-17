package ui

import (
	"os"
	"testing"
)

// These tests run in a non-TTY environment (piped stdin in CI / go test),
// so they exercise the default-return paths only. Interactive paths require
// a real terminal and are not tested here.

func TestIsTTY_inTestEnv(t *testing.T) {
	// go test pipes stdin; we should NOT be a TTY.
	if IsTTY() {
		t.Log("stdin is a TTY — skipping non-TTY assertion (running interactively)")
		return
	}
}

func TestPromptInstallLocation_nonTTY(t *testing.T) {
	// Ensure stdin is not a terminal by redirecting from /dev/null.
	orig := os.Stdin
	f, err := os.Open(os.DevNull)
	if err != nil {
		t.Fatal(err)
	}
	os.Stdin = f
	defer func() {
		os.Stdin = orig
		f.Close()
	}()

	got, err := PromptInstallLocation()
	if err != nil {
		t.Fatalf("PromptInstallLocation() error: %v", err)
	}
	if got != LocationLocalBin {
		t.Errorf("non-TTY default = %q, want %q", got, LocationLocalBin)
	}
}

func TestPromptPATH_nonTTY(t *testing.T) {
	orig := os.Stdin
	f, err := os.Open(os.DevNull)
	if err != nil {
		t.Fatal(err)
	}
	os.Stdin = f
	defer func() {
		os.Stdin = orig
		f.Close()
	}()

	got, err := PromptPATH("~/.zshrc")
	if err != nil {
		t.Fatalf("PromptPATH() error: %v", err)
	}
	if !got {
		t.Error("non-TTY default for PromptPATH should be true")
	}
}

func TestPromptCompletions_nonTTY(t *testing.T) {
	orig := os.Stdin
	f, err := os.Open(os.DevNull)
	if err != nil {
		t.Fatal(err)
	}
	os.Stdin = f
	defer func() {
		os.Stdin = orig
		f.Close()
	}()

	got, err := PromptCompletions("zsh")
	if err != nil {
		t.Fatalf("PromptCompletions() error: %v", err)
	}
	if !got {
		t.Error("non-TTY default for PromptCompletions should be true")
	}
}

func TestPromptTelemetry_nonTTY(t *testing.T) {
	orig := os.Stdin
	f, err := os.Open(os.DevNull)
	if err != nil {
		t.Fatal(err)
	}
	os.Stdin = f
	defer func() {
		os.Stdin = orig
		f.Close()
	}()

	got, err := PromptTelemetry()
	if err != nil {
		t.Fatalf("PromptTelemetry() error: %v", err)
	}
	if got {
		t.Error("non-TTY default for PromptTelemetry should be false (opt-out)")
	}
}

func TestLocationConstants(t *testing.T) {
	if LocationLocalBin == "" {
		t.Error("LocationLocalBin must not be empty")
	}
	if LocationUsrLocal == "" {
		t.Error("LocationUsrLocal must not be empty")
	}
	if LocationCustom == "" {
		t.Error("LocationCustom must not be empty")
	}
}
