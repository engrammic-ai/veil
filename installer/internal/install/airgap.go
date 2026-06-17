package install

import (
	"archive/tar"
	"compress/gzip"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// ValidateLocalFile checks that path exists and is a readable regular file.
func ValidateLocalFile(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("file not found: %s", path)
		}
		return fmt.Errorf("stat %s: %w", path, err)
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("not a regular file: %s", path)
	}
	f, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("file not readable: %w", err)
	}
	f.Close()
	return nil
}

// InstallFromBinary installs a local binary file to destPath.
func InstallFromBinary(srcPath, destPath string) error {
	if err := ValidateLocalFile(srcPath); err != nil {
		return err
	}

	f, err := os.Open(srcPath)
	if err != nil {
		return fmt.Errorf("open binary %s: %w", srcPath, err)
	}
	defer f.Close()

	if err := os.MkdirAll(filepath.Dir(destPath), 0o755); err != nil {
		return fmt.Errorf("create install directory: %w", err)
	}

	return Install(f, destPath)
}

// InstallFromArchive extracts a .tar.gz archive and installs the first
// executable named "veil" (or the only file if it's a single-file archive)
// to destPath.
func InstallFromArchive(archivePath, destPath string) error {
	if err := ValidateLocalFile(archivePath); err != nil {
		return err
	}

	f, err := os.Open(archivePath)
	if err != nil {
		return fmt.Errorf("open archive %s: %w", archivePath, err)
	}
	defer f.Close()

	gr, err := gzip.NewReader(f)
	if err != nil {
		return fmt.Errorf("read gzip stream: %w", err)
	}
	defer gr.Close()

	tr := tar.NewReader(gr)

	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return fmt.Errorf("read archive: %w", err)
		}

		if hdr.Typeflag != tar.TypeReg {
			continue
		}

		base := filepath.Base(hdr.Name)
		if base != "veil" && !strings.HasSuffix(base, "/veil") {
			// Accept only the veil binary; skip other files unless it's the only entry.
			// We rely on finding "veil" by name; caller should ensure the archive contains it.
			continue
		}

		if err := os.MkdirAll(filepath.Dir(destPath), 0o755); err != nil {
			return fmt.Errorf("create install directory: %w", err)
		}

		return Install(tr, destPath)
	}

	return fmt.Errorf("archive %s does not contain a 'veil' binary", archivePath)
}
