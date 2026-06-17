package verify

import (
	"bufio"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"strings"
)

// ChecksumError is returned when a checksum verification fails.
type ChecksumError struct {
	Expected []byte
	Actual   []byte
}

func (e *ChecksumError) Error() string {
	return fmt.Sprintf("checksum mismatch: expected %x, got %x", e.Expected, e.Actual)
}

// ParseChecksums parses a checksums.txt file and returns a map of filename -> raw SHA256 bytes.
// Lines starting with '#' or empty lines are ignored. Each data line has the form:
//
//	<hex-digest>  <filename>
func ParseChecksums(content string) (map[string][]byte, error) {
	result := make(map[string][]byte)
	scanner := bufio.NewScanner(strings.NewReader(content))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) != 2 {
			return nil, fmt.Errorf("malformed checksum line: %q", line)
		}
		digest, err := hex.DecodeString(fields[0])
		if err != nil {
			return nil, fmt.Errorf("invalid hex digest in line %q: %w", line, err)
		}
		result[fields[1]] = digest
	}
	return result, scanner.Err()
}

// ComputeSHA256 reads all bytes from r and returns the SHA256 digest.
func ComputeSHA256(r io.Reader) ([]byte, error) {
	h := sha256.New()
	if _, err := io.Copy(h, r); err != nil {
		return nil, fmt.Errorf("compute sha256: %w", err)
	}
	sum := h.Sum(nil)
	return sum, nil
}

// VerifyChecksum computes the SHA256 of binary and compares it to expected using
// constant-time comparison. Returns a *ChecksumError if they differ.
func VerifyChecksum(binary io.Reader, expected []byte) error {
	actual, err := ComputeSHA256(binary)
	if err != nil {
		return err
	}
	if !hmac.Equal(expected, actual) {
		return &ChecksumError{Expected: expected, Actual: actual}
	}
	return nil
}
