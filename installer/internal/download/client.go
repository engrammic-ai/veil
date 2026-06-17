package download

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"time"
)

const (
	defaultTimeout    = 5 * time.Minute
	maxRetries        = 3
	retryBaseDelay    = 1 * time.Second
)

// Client is an HTTP client with retry, proxy, and CA cert support.
type Client struct {
	http    *http.Client
	timeout time.Duration
}

// ClientOptions configures a Client.
type ClientOptions struct {
	Timeout  time.Duration
	ProxyURL string // overrides HTTP_PROXY/HTTPS_PROXY env vars
	CACert   string // path to PEM file, overrides SSL_CERT_FILE env var
}

// NewClient constructs a Client. Zero-value ClientOptions uses defaults and env vars.
func NewClient(opts ClientOptions) (*Client, error) {
	timeout := opts.Timeout
	if timeout == 0 {
		timeout = defaultTimeout
	}

	transport := &http.Transport{}

	if err := applyProxy(transport, opts.ProxyURL); err != nil {
		return nil, fmt.Errorf("proxy config: %w", err)
	}

	if err := applyCACert(transport, opts.CACert); err != nil {
		return nil, fmt.Errorf("CA cert: %w", err)
	}

	return &Client{
		http:    &http.Client{Transport: transport, Timeout: timeout},
		timeout: timeout,
	}, nil
}

func applyProxy(t *http.Transport, proxyURL string) error {
	if proxyURL == "" {
		// Fall through to env-var proxy (default Go behaviour).
		t.Proxy = http.ProxyFromEnvironment
		return nil
	}
	u, err := url.Parse(proxyURL)
	if err != nil {
		return fmt.Errorf("invalid proxy URL %q: %w", proxyURL, err)
	}
	t.Proxy = http.ProxyURL(u)
	return nil
}

func applyCACert(t *http.Transport, certPath string) error {
	if certPath == "" {
		certPath = os.Getenv("SSL_CERT_FILE")
	}
	if certPath == "" {
		return nil
	}

	pem, err := os.ReadFile(certPath)
	if err != nil {
		return fmt.Errorf("read CA cert %q: %w", certPath, err)
	}

	pool, err := x509.SystemCertPool()
	if err != nil {
		pool = x509.NewCertPool()
	}
	if !pool.AppendCertsFromPEM(pem) {
		return fmt.Errorf("no valid certificates found in %q", certPath)
	}

	if t.TLSClientConfig == nil {
		t.TLSClientConfig = &tls.Config{}
	}
	t.TLSClientConfig.RootCAs = pool
	return nil
}

// Download fetches url into dest, calling onProgress for each chunk if non-nil.
// Retries up to maxRetries times on transient errors with exponential backoff.
func (c *Client) Download(ctx context.Context, rawURL, dest string, onProgress ProgressFunc) error {
	var lastErr error
	delay := retryBaseDelay

	for attempt := 0; attempt < maxRetries; attempt++ {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(delay):
				delay *= 2
			}
		}

		if err := c.downloadOnce(ctx, rawURL, dest, onProgress); err != nil {
			if isTransient(err) {
				lastErr = err
				continue
			}
			return err
		}
		return nil
	}
	return fmt.Errorf("download failed after %d attempts: %w", maxRetries, lastErr)
}

func (c *Client) downloadOnce(ctx context.Context, rawURL, dest string, onProgress ProgressFunc) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return err
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 500 {
		return fmt.Errorf("server error: %s", resp.Status)
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("unexpected status: %s", resp.Status)
	}

	f, err := os.Create(dest)
	if err != nil {
		return fmt.Errorf("create dest file: %w", err)
	}
	defer f.Close()

	var src io.Reader = resp.Body
	if onProgress != nil {
		src = &ProgressReader{
			Reader: resp.Body,
			Total:  resp.ContentLength,
			OnProgress: onProgress,
		}
	}

	if _, err := io.Copy(f, src); err != nil {
		os.Remove(dest)
		return fmt.Errorf("write: %w", err)
	}
	return nil
}

// isTransient returns true for errors that warrant a retry.
func isTransient(err error) bool {
	if err == nil {
		return false
	}
	// 5xx errors embedded in message by downloadOnce.
	msg := err.Error()
	for _, prefix := range []string{
		"server error: 500",
		"server error: 502",
		"server error: 503",
		"server error: 504",
	} {
		if len(msg) >= len(prefix) && msg[:len(prefix)] == prefix {
			return true
		}
	}
	// Network-level errors: timeouts, connection resets, etc.
	var netErr net.Error
	if errors.As(err, &netErr) {
		return true
	}
	return false
}
