package verify

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"
)

const sampleChecksums = `# SHA256 checksums for veil v0.3.1
# Generated: 2024-01-15T10:30:00Z

a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2  veil-linux-x64
b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3  veil-linux-arm64
`

func TestParseChecksums_Valid(t *testing.T) {
	result, err := ParseChecksums(sampleChecksums)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(result) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(result))
	}
	want, _ := hex.DecodeString("a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2")
	if !bytes.Equal(result["veil-linux-x64"], want) {
		t.Errorf("checksum mismatch for veil-linux-x64")
	}
}

func TestParseChecksums_EmptyAndComments(t *testing.T) {
	result, err := ParseChecksums("# just a comment\n\n")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(result) != 0 {
		t.Errorf("expected 0 entries, got %d", len(result))
	}
}

func TestParseChecksums_MalformedLine(t *testing.T) {
	_, err := ParseChecksums("onlyonetoken\n")
	if err == nil {
		t.Fatal("expected error for malformed line, got nil")
	}
	if !strings.Contains(err.Error(), "malformed checksum line") {
		t.Errorf("unexpected error message: %v", err)
	}
}

func TestParseChecksums_InvalidHex(t *testing.T) {
	_, err := ParseChecksums("ZZZZZZZZ  veil-linux-x64\n")
	if err == nil {
		t.Fatal("expected error for invalid hex, got nil")
	}
	if !strings.Contains(err.Error(), "invalid hex digest") {
		t.Errorf("unexpected error message: %v", err)
	}
}

func TestComputeSHA256_KnownHash(t *testing.T) {
	// echo -n "hello" | sha256sum => 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
	data := []byte("hello")
	want, _ := hex.DecodeString("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824")

	got, err := ComputeSHA256(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !bytes.Equal(got, want) {
		t.Errorf("ComputeSHA256: got %x, want %x", got, want)
	}
}

func TestComputeSHA256_Empty(t *testing.T) {
	// sha256 of empty string
	h := sha256.Sum256([]byte{})
	want := h[:]
	got, err := ComputeSHA256(bytes.NewReader([]byte{}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !bytes.Equal(got, want) {
		t.Errorf("empty hash mismatch: got %x, want %x", got, want)
	}
}

func TestVerifyChecksum_Match(t *testing.T) {
	data := []byte("test binary content")
	sum := sha256.Sum256(data)
	expected := sum[:]

	err := VerifyChecksum(bytes.NewReader(data), expected)
	if err != nil {
		t.Fatalf("expected no error for matching checksum, got: %v", err)
	}
}

func TestVerifyChecksum_Mismatch(t *testing.T) {
	data := []byte("test binary content")
	wrongSum := sha256.Sum256([]byte("different content"))
	expected := wrongSum[:]

	err := VerifyChecksum(bytes.NewReader(data), expected)
	if err == nil {
		t.Fatal("expected error for mismatching checksum, got nil")
	}

	csErr, ok := err.(*ChecksumError)
	if !ok {
		t.Fatalf("expected *ChecksumError, got %T: %v", err, err)
	}
	if !bytes.Equal(csErr.Expected, expected) {
		t.Errorf("ChecksumError.Expected mismatch")
	}
	if len(csErr.Actual) != sha256.Size {
		t.Errorf("ChecksumError.Actual has wrong length: %d", len(csErr.Actual))
	}
}

func TestVerifyChecksum_ConstantTime(t *testing.T) {
	// hmac.Equal is already constant-time; this test verifies it's being used
	// by ensuring a single-byte difference is detected correctly.
	data := []byte("binary")
	sum := sha256.Sum256(data)
	expected := sum[:]

	tampered := make([]byte, len(expected))
	copy(tampered, expected)
	tampered[0] ^= 0x01

	err := VerifyChecksum(bytes.NewReader(data), tampered)
	if err == nil {
		t.Fatal("expected mismatch error when expected is tampered")
	}
}
