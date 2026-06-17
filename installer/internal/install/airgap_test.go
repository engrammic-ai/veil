package install

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"os"
	"path/filepath"
	"testing"
)

// makeTarGz creates a .tar.gz archive in dir containing a single file named
// entryName with the given content.
func makeTarGz(t *testing.T, dir, entryName string, content []byte) string {
	t.Helper()
	archivePath := filepath.Join(dir, "bundle.tar.gz")
	f, err := os.Create(archivePath)
	if err != nil {
		t.Fatalf("create archive: %v", err)
	}
	defer f.Close()

	gw := gzip.NewWriter(f)
	tw := tar.NewWriter(gw)

	hdr := &tar.Header{
		Name:     entryName,
		Mode:     0o755,
		Size:     int64(len(content)),
		Typeflag: tar.TypeReg,
	}
	if err := tw.WriteHeader(hdr); err != nil {
		t.Fatalf("tar write header: %v", err)
	}
	if _, err := tw.Write(content); err != nil {
		t.Fatalf("tar write content: %v", err)
	}
	tw.Close()
	gw.Close()
	return archivePath
}

// ---- ValidateLocalFile -------------------------------------------------------

func TestValidateLocalFile_OK(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "file.bin")
	os.WriteFile(p, []byte("data"), 0o644)

	if err := ValidateLocalFile(p); err != nil {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestValidateLocalFile_Missing(t *testing.T) {
	err := ValidateLocalFile("/nonexistent/path/file.bin")
	if err == nil {
		t.Error("expected error for missing file")
	}
}

func TestValidateLocalFile_Directory(t *testing.T) {
	dir := t.TempDir()
	err := ValidateLocalFile(dir)
	if err == nil {
		t.Error("expected error for directory path")
	}
}

// ---- InstallFromBinary -------------------------------------------------------

func TestInstallFromBinary_WritesContent(t *testing.T) {
	dir := t.TempDir()
	srcPath := filepath.Join(dir, "veil-src")
	content := []byte("binary content")
	os.WriteFile(srcPath, content, 0o755)

	destPath := filepath.Join(dir, "bin", "veil")
	os.MkdirAll(filepath.Dir(destPath), 0o755)

	if err := InstallFromBinary(srcPath, destPath); err != nil {
		t.Fatalf("InstallFromBinary: %v", err)
	}

	got, err := os.ReadFile(destPath)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if !bytes.Equal(got, content) {
		t.Errorf("content mismatch: got %q want %q", got, content)
	}
}

func TestInstallFromBinary_SetsExecutable(t *testing.T) {
	dir := t.TempDir()
	srcPath := filepath.Join(dir, "veil-src")
	os.WriteFile(srcPath, []byte("x"), 0o644)

	destPath := filepath.Join(dir, "veil")
	if err := InstallFromBinary(srcPath, destPath); err != nil {
		t.Fatalf("InstallFromBinary: %v", err)
	}

	info, err := os.Stat(destPath)
	if err != nil {
		t.Fatalf("Stat: %v", err)
	}
	if info.Mode()&0o111 == 0 {
		t.Errorf("binary is not executable: mode %v", info.Mode())
	}
}

func TestInstallFromBinary_MissingSource(t *testing.T) {
	dir := t.TempDir()
	err := InstallFromBinary("/nonexistent/veil", filepath.Join(dir, "veil"))
	if err == nil {
		t.Error("expected error for missing source file")
	}
}

func TestInstallFromBinary_CreatesDestDir(t *testing.T) {
	dir := t.TempDir()
	srcPath := filepath.Join(dir, "veil-src")
	os.WriteFile(srcPath, []byte("x"), 0o755)

	// Dest directory does not exist yet; InstallFromBinary should create it.
	destPath := filepath.Join(dir, "nested", "dir", "veil")
	if err := InstallFromBinary(srcPath, destPath); err != nil {
		t.Fatalf("InstallFromBinary: %v", err)
	}
	if _, err := os.Stat(destPath); err != nil {
		t.Errorf("dest file missing: %v", err)
	}
}

// ---- InstallFromArchive ------------------------------------------------------

func TestInstallFromArchive_ExtractsVeil(t *testing.T) {
	dir := t.TempDir()
	content := []byte("veil binary from archive")
	archivePath := makeTarGz(t, dir, "veil", content)

	destPath := filepath.Join(dir, "bin", "veil")
	os.MkdirAll(filepath.Dir(destPath), 0o755)

	if err := InstallFromArchive(archivePath, destPath); err != nil {
		t.Fatalf("InstallFromArchive: %v", err)
	}

	got, err := os.ReadFile(destPath)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if !bytes.Equal(got, content) {
		t.Errorf("content mismatch: got %q want %q", got, content)
	}
}

func TestInstallFromArchive_NestedVeilEntry(t *testing.T) {
	dir := t.TempDir()
	content := []byte("nested veil")
	archivePath := makeTarGz(t, dir, "veil-1.2.3-linux-amd64/veil", content)

	destPath := filepath.Join(dir, "veil")
	if err := InstallFromArchive(archivePath, destPath); err != nil {
		t.Fatalf("InstallFromArchive: %v", err)
	}

	got, _ := os.ReadFile(destPath)
	if !bytes.Equal(got, content) {
		t.Errorf("content mismatch")
	}
}

func TestInstallFromArchive_SetsExecutable(t *testing.T) {
	dir := t.TempDir()
	archivePath := makeTarGz(t, dir, "veil", []byte("x"))

	destPath := filepath.Join(dir, "veil")
	if err := InstallFromArchive(archivePath, destPath); err != nil {
		t.Fatalf("InstallFromArchive: %v", err)
	}

	info, err := os.Stat(destPath)
	if err != nil {
		t.Fatalf("Stat: %v", err)
	}
	if info.Mode()&0o111 == 0 {
		t.Errorf("binary not executable: mode %v", info.Mode())
	}
}

func TestInstallFromArchive_NoVeilEntry(t *testing.T) {
	dir := t.TempDir()
	archivePath := makeTarGz(t, dir, "other-binary", []byte("not veil"))

	err := InstallFromArchive(archivePath, filepath.Join(dir, "veil"))
	if err == nil {
		t.Error("expected error when archive has no 'veil' entry")
	}
}

func TestInstallFromArchive_MissingArchive(t *testing.T) {
	dir := t.TempDir()
	err := InstallFromArchive("/nonexistent/bundle.tar.gz", filepath.Join(dir, "veil"))
	if err == nil {
		t.Error("expected error for missing archive")
	}
}

func TestInstallFromArchive_NotGzip(t *testing.T) {
	dir := t.TempDir()
	badPath := filepath.Join(dir, "bad.tar.gz")
	os.WriteFile(badPath, []byte("not a gzip file"), 0o644)

	err := InstallFromArchive(badPath, filepath.Join(dir, "veil"))
	if err == nil {
		t.Error("expected error for corrupt gzip")
	}
}
