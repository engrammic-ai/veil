package install

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"fmt"
	"io"
	"os"
	"os/exec"
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

// InstallFromArchive extracts an archive (.tar.gz or .zip) to the install
// directory. It installs the veil binary to destPath and copies all support
// files (package.json, themes, assets, native modules) alongside it.
func InstallFromArchive(archivePath, destPath string) error {
	if err := ValidateLocalFile(archivePath); err != nil {
		return err
	}

	// Create temp directory for extraction
	tmpDir, err := os.MkdirTemp("", "veil-install-*")
	if err != nil {
		return fmt.Errorf("create temp dir: %w", err)
	}
	defer os.RemoveAll(tmpDir)

	// Extract based on file extension
	if strings.HasSuffix(archivePath, ".zip") {
		if err := extractZip(archivePath, tmpDir); err != nil {
			return fmt.Errorf("extract zip: %w", err)
		}
	} else {
		if err := extractTarGz(archivePath, tmpDir); err != nil {
			return fmt.Errorf("extract tar.gz: %w", err)
		}
	}

	// Find and install the binary
	binaryRelPath := findBinary(tmpDir)
	if binaryRelPath == "" {
		return fmt.Errorf("archive %s does not contain a veil binary", archivePath)
	}

	srcBinary := filepath.Join(tmpDir, binaryRelPath)
	// Support files are in the same directory as the binary
	srcDir := filepath.Dir(srcBinary)

	f, err := os.Open(srcBinary)
	if err != nil {
		return fmt.Errorf("open extracted binary: %w", err)
	}

	destDir := filepath.Dir(destPath)
	if err := os.MkdirAll(destDir, 0o755); err != nil {
		f.Close()
		return fmt.Errorf("create install directory: %w", err)
	}

	if err := Install(f, destPath); err != nil {
		f.Close()
		return fmt.Errorf("install binary: %w", err)
	}
	f.Close()

	// Copy support files alongside the binary
	supportFiles := []string{"package.json", "README.md", "CHANGELOG.md", "photon_rs_bg.wasm"}
	supportDirs := []string{"theme", "assets", "export-html", "docs", "examples", "node_modules", "native"}

	for _, file := range supportFiles {
		src := filepath.Join(srcDir, file)
		if _, err := os.Stat(src); err == nil {
			dst := filepath.Join(destDir, file)
			if err := copyFilePath(src, dst); err != nil {
				return fmt.Errorf("copy %s: %w", file, err)
			}
		}
	}

	for _, dir := range supportDirs {
		src := filepath.Join(srcDir, dir)
		if info, err := os.Stat(src); err == nil && info.IsDir() {
			dst := filepath.Join(destDir, dir)
			if err := copyDir(src, dst); err != nil {
				return fmt.Errorf("copy %s: %w", dir, err)
			}
		}
	}

	// Install embedder server to ~/.local/share/veil/embedder/
	embedderSrc := filepath.Join(srcDir, "embedder")
	if info, err := os.Stat(embedderSrc); err == nil && info.IsDir() {
		home, err := os.UserHomeDir()
		if err != nil {
			return fmt.Errorf("get home dir: %w", err)
		}
		embedderDst := filepath.Join(home, ".local", "share", "veil", "embedder")
		if err := os.MkdirAll(filepath.Dir(embedderDst), 0o755); err != nil {
			return fmt.Errorf("create embedder parent dir: %w", err)
		}
		// Remove old embedder installation if present
		os.RemoveAll(embedderDst)
		if err := copyDir(embedderSrc, embedderDst); err != nil {
			return fmt.Errorf("install embedder: %w", err)
		}
		// Run npm install to ensure all dependencies are present
		// (workspace-hoisted deps may be missing from archive)
		if err := repairEmbedderDeps(embedderDst); err != nil {
			// Non-fatal: user can run 'veil-installer embedder repair' later
			fmt.Fprintf(os.Stderr, "Warning: could not install embedder dependencies: %v\n", err)
		}
	}

	return nil
}

// findBinary looks for a veil binary in the extracted directory.
// It searches recursively and returns the relative path from dir.
func findBinary(dir string) string {
	var result string

	filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}

		name := d.Name()
		// Match "veil", "veil.exe", or "veil-<platform>" / "veil-<platform>.exe"
		if name == "veil" || name == "veil.exe" ||
			(strings.HasPrefix(name, "veil-") && !strings.HasSuffix(name, ".json")) {
			rel, err := filepath.Rel(dir, path)
			if err == nil {
				result = rel
				return filepath.SkipAll
			}
		}
		return nil
	})

	return result
}

// extractTarGz extracts a .tar.gz archive to destDir.
func extractTarGz(archivePath, destDir string) error {
	f, err := os.Open(archivePath)
	if err != nil {
		return fmt.Errorf("open archive: %w", err)
	}
	defer f.Close()

	gr, err := gzip.NewReader(f)
	if err != nil {
		return fmt.Errorf("gzip reader: %w", err)
	}
	defer gr.Close()

	tr := tar.NewReader(gr)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return fmt.Errorf("tar read: %w", err)
		}

		target := filepath.Join(destDir, hdr.Name)

		// Prevent path traversal
		if !strings.HasPrefix(filepath.Clean(target), filepath.Clean(destDir)+string(os.PathSeparator)) {
			return fmt.Errorf("invalid tar path: %s", hdr.Name)
		}

		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, os.FileMode(hdr.Mode)); err != nil {
				return fmt.Errorf("create directory %s: %w", target, err)
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return fmt.Errorf("create parent directory: %w", err)
			}
			outFile, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, os.FileMode(hdr.Mode))
			if err != nil {
				return fmt.Errorf("create file %s: %w", target, err)
			}
			if _, err := io.Copy(outFile, tr); err != nil {
				outFile.Close()
				return fmt.Errorf("write file %s: %w", target, err)
			}
			outFile.Close()
		case tar.TypeSymlink:
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return fmt.Errorf("create parent directory: %w", err)
			}
			if err := os.Symlink(hdr.Linkname, target); err != nil {
				return fmt.Errorf("create symlink %s: %w", target, err)
			}
		}
	}
	return nil
}

// extractZip extracts a .zip archive to destDir.
func extractZip(archivePath, destDir string) error {
	r, err := zip.OpenReader(archivePath)
	if err != nil {
		return fmt.Errorf("open zip: %w", err)
	}
	defer r.Close()

	for _, f := range r.File {
		target := filepath.Join(destDir, f.Name)

		// Prevent path traversal
		if !strings.HasPrefix(filepath.Clean(target), filepath.Clean(destDir)+string(os.PathSeparator)) {
			return fmt.Errorf("invalid zip path: %s", f.Name)
		}

		if f.FileInfo().IsDir() {
			if err := os.MkdirAll(target, f.Mode()); err != nil {
				return fmt.Errorf("create directory %s: %w", target, err)
			}
			continue
		}

		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return fmt.Errorf("create parent directory: %w", err)
		}

		rc, err := f.Open()
		if err != nil {
			return fmt.Errorf("open zip entry %s: %w", f.Name, err)
		}

		outFile, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, f.Mode())
		if err != nil {
			rc.Close()
			return fmt.Errorf("create file %s: %w", target, err)
		}

		if _, err := io.Copy(outFile, rc); err != nil {
			outFile.Close()
			rc.Close()
			return fmt.Errorf("write file %s: %w", target, err)
		}

		outFile.Close()
		rc.Close()
	}
	return nil
}

// copyFilePath copies a file from src path to dst path.
func copyFilePath(src, dst string) error {
	srcFile, err := os.Open(src)
	if err != nil {
		return err
	}
	defer srcFile.Close()

	srcInfo, err := srcFile.Stat()
	if err != nil {
		return err
	}

	dstFile, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, srcInfo.Mode())
	if err != nil {
		return err
	}
	defer dstFile.Close()

	_, err = io.Copy(dstFile, srcFile)
	return err
}

// copyDir recursively copies a directory from src to dst.
func copyDir(src, dst string) error {
	srcInfo, err := os.Stat(src)
	if err != nil {
		return err
	}

	if err := os.MkdirAll(dst, srcInfo.Mode()); err != nil {
		return err
	}

	entries, err := os.ReadDir(src)
	if err != nil {
		return err
	}

	for _, entry := range entries {
		srcPath := filepath.Join(src, entry.Name())
		dstPath := filepath.Join(dst, entry.Name())

		if entry.IsDir() {
			if err := copyDir(srcPath, dstPath); err != nil {
				return err
			}
		} else {
			if err := copyFilePath(srcPath, dstPath); err != nil {
				return err
			}
		}
	}
	return nil
}

// IsArchive returns true if the path or URL points to an archive file.
func IsArchive(path string) bool {
	return strings.HasSuffix(path, ".tar.gz") ||
		strings.HasSuffix(path, ".tgz") ||
		strings.HasSuffix(path, ".zip")
}

// BinaryNameForPlatform returns the expected binary name for a platform.
func BinaryNameForPlatform(platform string) string {
	if strings.HasPrefix(platform, "windows") {
		return "veil-" + platform + ".exe"
	}
	return "veil-" + platform
}

// repairEmbedderDeps runs npm install in the embedder directory to ensure
// all dependencies are present. This is needed because npm workspace hoisting
// may leave the archive with incomplete node_modules.
func repairEmbedderDeps(embedderDir string) error {
	pkgJSON := filepath.Join(embedderDir, "package.json")
	if _, err := os.Stat(pkgJSON); os.IsNotExist(err) {
		return nil // No package.json, nothing to install
	}

	cmd := exec.Command("npm", "install", "--omit=dev")
	cmd.Dir = embedderDir
	// Suppress npm output unless there's an error
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%w: %s", err, string(output))
	}
	return nil
}
