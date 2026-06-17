package platform

import (
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
)

// Platform describes the host system for binary selection.
type Platform struct {
	OS      string // linux, darwin, windows
	Arch    string // x64, arm64
	LibC    string // glibc, musl (Linux only, empty otherwise)
	Version string // OS version string
}

// String returns a normalized platform identifier, e.g. "linux-arm64-musl".
func (p Platform) String() string {
	if p.LibC != "" {
		return fmt.Sprintf("%s-%s-%s", p.OS, p.Arch, p.LibC)
	}
	return fmt.Sprintf("%s-%s", p.OS, p.Arch)
}

// Detect returns the current host platform.
func Detect() Platform {
	p := Platform{
		OS:   runtime.GOOS,
		Arch: normalizeArch(runtime.GOARCH),
	}

	if p.OS == "linux" {
		p.LibC = detectLibC()
		p.Version = detectLinuxVersion()
	}

	return p
}

func normalizeArch(goarch string) string {
	switch goarch {
	case "amd64", "x86_64":
		return "x64"
	case "arm64", "aarch64":
		return "arm64"
	default:
		return goarch
	}
}

// detectLibC identifies whether the host uses glibc or musl.
// It checks for musl loader paths first (fast, no exec), then falls back to
// running ldd --version and inspecting the output.
func detectLibC() string {
	// Musl installs a known loader path; check without executing anything.
	muslPaths := []string{
		"/lib/ld-musl-x86_64.so.1",
		"/lib/ld-musl-aarch64.so.1",
		"/lib/ld-musl-armhf.so.1",
	}
	for _, path := range muslPaths {
		if _, err := os.Stat(path); err == nil {
			return "musl"
		}
	}

	// Fall back to ldd --version; glibc prints "GNU libc", musl prints "musl".
	out, err := exec.Command("ldd", "--version").CombinedOutput()
	if err == nil {
		lower := strings.ToLower(string(out))
		if strings.Contains(lower, "musl") {
			return "musl"
		}
		if strings.Contains(lower, "gnu") || strings.Contains(lower, "glibc") {
			return "glibc"
		}
	}

	// Default to glibc — it is the most common libc on Linux.
	return "glibc"
}

func detectLinuxVersion() string {
	data, err := os.ReadFile("/etc/os-release")
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, "VERSION_ID=") {
			return strings.Trim(strings.TrimPrefix(line, "VERSION_ID="), `"`)
		}
	}
	return ""
}
