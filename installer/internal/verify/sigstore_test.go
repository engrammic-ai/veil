package verify

import (
	"errors"
	"strings"
	"testing"
)

func TestDefaultSigstoreOptions(t *testing.T) {
	opts := DefaultSigstoreOptions("v0.3.1")
	if opts.OIDCIssuer != DefaultOIDCIssuer {
		t.Errorf("OIDCIssuer: got %q, want %q", opts.OIDCIssuer, DefaultOIDCIssuer)
	}
	wantIdentity := DefaultCertIdentityPrefix + "v0.3.1"
	if opts.CertIdentity != wantIdentity {
		t.Errorf("CertIdentity: got %q, want %q", opts.CertIdentity, wantIdentity)
	}
}

func TestVerifySigstore_EmptyCertIdentity(t *testing.T) {
	err := VerifySigstore([]byte("data"), []byte("sig"), SigstoreOptions{
		CertIdentity: "",
		OIDCIssuer:   DefaultOIDCIssuer,
	})
	if err == nil {
		t.Fatal("expected error for empty CertIdentity")
	}
	if !strings.Contains(err.Error(), "CertIdentity") {
		t.Errorf("unexpected error message: %v", err)
	}
}

func TestVerifySigstore_EmptyOIDCIssuer(t *testing.T) {
	err := VerifySigstore([]byte("data"), []byte("sig"), SigstoreOptions{
		CertIdentity: DefaultCertIdentityPrefix + "v0.3.1",
		OIDCIssuer:   "",
	})
	if err == nil {
		t.Fatal("expected error for empty OIDCIssuer")
	}
	if !strings.Contains(err.Error(), "OIDCIssuer") {
		t.Errorf("unexpected error message: %v", err)
	}
}

func TestVerifySigstore_CosignNotInstalled(t *testing.T) {
	// Override PATH so cosign cannot be found.
	t.Setenv("PATH", t.TempDir())

	err := VerifySigstore([]byte("checksums"), []byte("sig"), DefaultSigstoreOptions("v0.3.1"))
	if !errors.Is(err, ErrCosignNotFound) {
		t.Fatalf("expected ErrCosignNotFound, got: %v", err)
	}
}

func TestVerifySigstore_CosignRejectsInvalidSignature(t *testing.T) {
	// Skip if cosign is not on PATH — this test requires the real binary.
	if _, err := findCosign(); err != nil {
		t.Skip("cosign not available; skipping live verification test")
	}

	err := VerifySigstore(
		[]byte("not real checksums"),
		[]byte("not a real sigstore bundle"),
		DefaultSigstoreOptions("v0.3.1"),
	)
	if err == nil {
		t.Fatal("expected cosign to reject invalid signature, got nil")
	}

	var sigErr *SigstoreError
	if !errors.As(err, &sigErr) {
		t.Fatalf("expected *SigstoreError, got %T: %v", err, err)
	}
}

func TestSigstoreError_Error(t *testing.T) {
	e := &SigstoreError{Stderr: "  verification failed\n", Cause: errors.New("exit 1")}
	msg := e.Error()
	if !strings.Contains(msg, "sigstore verification failed") {
		t.Errorf("unexpected error string: %q", msg)
	}
	if !strings.Contains(msg, "verification failed") {
		t.Errorf("stderr not included in error string: %q", msg)
	}
}

func TestSigstoreError_Unwrap(t *testing.T) {
	cause := errors.New("exit status 1")
	e := &SigstoreError{Cause: cause}
	if !errors.Is(e, cause) {
		t.Error("Unwrap should expose the underlying cause")
	}
}

// findCosign is a test-only helper that mirrors the lookup in VerifySigstore.
func findCosign() (string, error) {
	return findBinary("cosign")
}
