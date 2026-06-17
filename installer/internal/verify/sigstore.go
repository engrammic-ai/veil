package verify

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

const (
	DefaultCertIdentityPrefix = "https://github.com/engrammic-ai/veil/.github/workflows/release.yml@refs/tags/"
	DefaultOIDCIssuer         = "https://token.actions.githubusercontent.com"
)

// SigstoreOptions configures cosign verify-blob parameters.
type SigstoreOptions struct {
	// CertIdentity is the full certificate identity URI expected in the Fulcio cert.
	// Typically the GitHub Actions workflow ref, e.g.
	// "https://github.com/engrammic-ai/veil/.github/workflows/release.yml@refs/tags/v0.3.1"
	CertIdentity string

	// OIDCIssuer is the expected OIDC issuer embedded in the Fulcio cert.
	OIDCIssuer string
}

// DefaultSigstoreOptions returns options matching the engrammic-ai/veil release workflow.
func DefaultSigstoreOptions(version string) SigstoreOptions {
	return SigstoreOptions{
		CertIdentity: DefaultCertIdentityPrefix + version,
		OIDCIssuer:   DefaultOIDCIssuer,
	}
}

// SigstoreError wraps a cosign verification failure with its stderr output.
type SigstoreError struct {
	Stderr string
	Cause  error
}

func (e *SigstoreError) Error() string {
	if e.Stderr != "" {
		return fmt.Sprintf("sigstore verification failed: %s", strings.TrimSpace(e.Stderr))
	}
	return fmt.Sprintf("sigstore verification failed: %v", e.Cause)
}

func (e *SigstoreError) Unwrap() error { return e.Cause }

// ErrCosignNotFound is returned when the cosign binary cannot be located.
var ErrCosignNotFound = errors.New("cosign binary not found; install cosign to enable Sigstore verification")

// VerifySigstore verifies that signature is a valid Sigstore bundle for checksums,
// produced by the GitHub Actions workflow identified in opts.
//
// It shells out to the cosign binary. If cosign is not installed, ErrCosignNotFound
// is returned so callers can decide whether to treat absence as fatal.
func VerifySigstore(checksums []byte, signature []byte, opts SigstoreOptions) error {
	if err := validateOpts(opts); err != nil {
		return err
	}

	cosignPath, err := findBinary("cosign")
	if err != nil {
		return ErrCosignNotFound
	}

	// Write checksums and signature to temp files so cosign can read them.
	checksumsFile, err := writeTempFile("checksums-*", checksums)
	if err != nil {
		return fmt.Errorf("sigstore: write temp checksums: %w", err)
	}
	defer removeTempFile(checksumsFile)

	sigFile, err := writeTempFile("checksums-*.sigstore", signature)
	if err != nil {
		return fmt.Errorf("sigstore: write temp signature: %w", err)
	}
	defer removeTempFile(sigFile)

	cmd := exec.Command(cosignPath, //nolint:gosec // path resolved via LookPath
		"verify-blob",
		"--certificate-identity="+opts.CertIdentity,
		"--certificate-oidc-issuer="+opts.OIDCIssuer,
		"--signature="+sigFile,
		checksumsFile,
	)

	out, err := cmd.CombinedOutput()
	if err != nil {
		return &SigstoreError{Stderr: string(out), Cause: err}
	}
	return nil
}

func findBinary(name string) (string, error) { return exec.LookPath(name) }

func writeTempFile(pattern string, data []byte) (string, error) {
	f, err := os.CreateTemp("", pattern)
	if err != nil {
		return "", err
	}
	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		_ = os.Remove(f.Name())
		return "", err
	}
	return f.Name(), f.Close()
}

func removeTempFile(name string) { _ = os.Remove(name) }

func validateOpts(opts SigstoreOptions) error {
	if opts.CertIdentity == "" {
		return errors.New("SigstoreOptions.CertIdentity must not be empty")
	}
	if opts.OIDCIssuer == "" {
		return errors.New("SigstoreOptions.OIDCIssuer must not be empty")
	}
	return nil
}
