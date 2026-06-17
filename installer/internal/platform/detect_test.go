package platform

import (
	"runtime"
	"strings"
	"testing"
)

func TestNormalizeArch(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"amd64", "x64"},
		{"x86_64", "x64"},
		{"arm64", "arm64"},
		{"aarch64", "arm64"},
		{"386", "386"},
		{"mips", "mips"},
	}
	for _, c := range cases {
		got := normalizeArch(c.in)
		if got != c.want {
			t.Errorf("normalizeArch(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestPlatformString(t *testing.T) {
	cases := []struct {
		p    Platform
		want string
	}{
		{Platform{OS: "linux", Arch: "x64", LibC: "glibc"}, "linux-x64-glibc"},
		{Platform{OS: "linux", Arch: "arm64", LibC: "musl"}, "linux-arm64-musl"},
		{Platform{OS: "darwin", Arch: "arm64"}, "darwin-arm64"},
		{Platform{OS: "darwin", Arch: "x64"}, "darwin-x64"},
		{Platform{OS: "windows", Arch: "x64"}, "windows-x64"},
	}
	for _, c := range cases {
		got := c.p.String()
		if got != c.want {
			t.Errorf("Platform%+v.String() = %q, want %q", c.p, got, c.want)
		}
	}
}

func TestDetect(t *testing.T) {
	p := Detect()

	validOS := map[string]bool{"linux": true, "darwin": true, "windows": true}
	if !validOS[p.OS] {
		t.Errorf("Detect().OS = %q, want one of linux/darwin/windows", p.OS)
	}

	validArch := map[string]bool{"x64": true, "arm64": true}
	if !validArch[p.Arch] {
		// Non-standard arch is not an error — just warn.
		t.Logf("Detect().Arch = %q (non-standard, GOARCH=%s)", p.Arch, runtime.GOARCH)
	}

	if p.OS == "linux" {
		if p.LibC != "glibc" && p.LibC != "musl" {
			t.Errorf("Detect().LibC = %q on Linux, want glibc or musl", p.LibC)
		}
	} else {
		if p.LibC != "" {
			t.Errorf("Detect().LibC = %q on non-Linux, want empty string", p.LibC)
		}
	}

	str := p.String()
	if !strings.HasPrefix(str, p.OS) {
		t.Errorf("Platform.String() %q does not start with OS %q", str, p.OS)
	}
	if !strings.Contains(str, p.Arch) {
		t.Errorf("Platform.String() %q does not contain Arch %q", str, p.Arch)
	}
}
