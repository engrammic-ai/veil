package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/engrammic-ai/veil-installer/internal/app"
	"github.com/engrammic-ai/veil-installer/internal/config"
	"github.com/engrammic-ai/veil-installer/internal/download"
	"github.com/engrammic-ai/veil-installer/internal/exitcodes"
	"github.com/engrammic-ai/veil-installer/internal/install"
	"github.com/engrammic-ai/veil-installer/internal/platform"
	"github.com/engrammic-ai/veil-installer/internal/verify"
	"github.com/spf13/cobra"
)

var (
	quiet         bool
	yes           bool
	channel       string
	version       string
	path          string
	noModifyPath  bool
	noCompletions bool
	purge         bool
	proxyURL      string
	caCert        string
	localBinary   string
	localArchive  string
	noTUI         bool
)

func main() {
	// Auto-install/update installer to ~/.local/bin on every run
	ensureInstallerInstalled()

	if err := rootCmd.Execute(); err != nil {
		// cobra already prints the error; use ErrGeneral as the fallback.
		exitcodes.Exit(exitcodes.ErrGeneral, "")
	}
}

// InstallerVersion should match app.InstallerVersion
const InstallerVersion = "0.1.27"

var rootCmd = &cobra.Command{
	Use:     "veil-installer",
	Short:   "Veil CLI installer and manager",
	Long:    "A TUI-based installer for the Veil CLI tool. Installs, updates, and manages Veil releases.",
	Version: InstallerVersion,
	Run:     runInstall,
}

var installCmd = &cobra.Command{
	Use:   "install",
	Short: "Install Veil CLI",
	Long:  "Download and install the Veil CLI to the specified path.",
	Run:   runInstall,
}

var updateCmd = &cobra.Command{
	Use:   "update",
	Short: "Update Veil CLI to a newer version",
	Run:   runUpdate,
}

var uninstallCmd = &cobra.Command{
	Use:   "uninstall",
	Short: "Remove Veil CLI from the system",
	Run:   runUninstall,
}

var infoCmd = &cobra.Command{
	Use:   "info",
	Short: "Show information about the installed Veil CLI",
	Run:   runInfo,
}

var releasesCmd = &cobra.Command{
	Use:   "releases",
	Short: "List available Veil releases",
	Run:   runReleases,
}

var checkCmd = &cobra.Command{
	Use:   "check",
	Short: "Check if a newer version of Veil is available",
	Long:  "Check if a newer version of Veil is available. Exits with code 10 if an update is available.",
	Run:   runCheck,
}

var selfUpdateCmd = &cobra.Command{
	Use:   "self-update",
	Short: "Update the installer itself to the latest version",
	Long:  "Download and install the latest version of veil-installer from the releases server.",
	Run:   runSelfUpdate,
}

var embedderCmd = &cobra.Command{
	Use:   "embedder",
	Short: "Manage the Veil embedder server",
}

var embedderCacheCmd = &cobra.Command{
	Use:   "cache",
	Short: "Manage embedder model cache",
}

var embedderCacheClearCmd = &cobra.Command{
	Use:   "clear",
	Short: "Clear cached embedding models",
	Long:  "Remove all cached embedding models from ~/.cache/veil/models/. Models will be re-downloaded on next use.",
	Run:   runEmbedderCacheClear,
}

func init() {
	rootCmd.PersistentFlags().BoolVarP(&quiet, "quiet", "q", false, "Suppress non-essential output")
	rootCmd.PersistentFlags().BoolVarP(&yes, "yes", "y", false, "Assume yes to all prompts")
	rootCmd.PersistentFlags().StringVar(&channel, "channel", "stable", "Release channel (stable, beta, nightly)")
	rootCmd.PersistentFlags().StringVarP(&version, "install-version", "V", "", "Specific version to install (e.g. 1.2.3)")
	rootCmd.PersistentFlags().StringVar(&path, "path", "", "Installation path (defaults to system path)")
	rootCmd.PersistentFlags().StringVar(&proxyURL, "proxy", "", "HTTP/HTTPS proxy URL")
	rootCmd.PersistentFlags().StringVar(&caCert, "ca-cert", "", "Path to CA certificate PEM file")
	rootCmd.PersistentFlags().BoolVar(&noTUI, "no-tui", false, "Disable interactive TUI (use plain CLI output)")

	installCmd.Flags().BoolVar(&noModifyPath, "no-modify-path", false, "Do not modify shell PATH configuration")
	installCmd.Flags().BoolVar(&noCompletions, "no-completions", false, "Do not install shell completions")
	installCmd.Flags().StringVar(&localBinary, "binary", "", "Install from a local binary file (airgapped)")
	installCmd.Flags().StringVar(&localArchive, "archive", "", "Install from a local .tar.gz archive (airgapped)")

	updateCmd.Flags().BoolVar(&noCompletions, "no-completions", false, "Do not update shell completions")

	uninstallCmd.Flags().BoolVar(&purge, "purge", false, "Also remove configuration and data files")

	embedderCacheCmd.AddCommand(embedderCacheClearCmd)
	embedderCmd.AddCommand(embedderCacheCmd)
	rootCmd.AddCommand(installCmd, updateCmd, uninstallCmd, infoCmd, releasesCmd, checkCmd, selfUpdateCmd, embedderCmd)
}

// newDownloadClient creates a download client with proxy/CA-cert config from flags.
func newDownloadClient() (*download.Client, error) {
	return download.NewClient(download.ClientOptions{
		ProxyURL: proxyURL,
		CACert:   caCert,
	})
}

// resolveInstallPath returns the destination binary path.
// If --path is set, it is used directly. Otherwise defaults to ~/.local/bin/veil.
func resolveInstallPath() (string, error) {
	if path != "" {
		return path, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolve home directory: %w", err)
	}
	return filepath.Join(home, ".local", "bin", "veil"), nil
}

// backupDir returns the directory used to store backups.
func backupDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".local", "share", "veil", "backups"), nil
}

// installedVersion attempts to determine the version of the currently installed binary.
func installedVersion(installPath string) string {
	// Check .veil-version file first.
	versionFile := filepath.Join(filepath.Dir(installPath), ".veil-version")
	if data, err := os.ReadFile(versionFile); err == nil && len(data) > 0 {
		return strings.TrimSpace(string(data))
	}
	// Fall back to running the binary.
	out, err := exec.Command(installPath, "--version").Output()
	if err != nil {
		return "unknown"
	}
	return strings.TrimSpace(string(out))
}

func runInstall(cmd *cobra.Command, args []string) {
	// Airgapped install: skip TUI entirely.
	if localBinary != "" || localArchive != "" {
		runAirgapInstall(cmd, args)
		return
	}

	// Use interactive TUI unless --no-tui or --quiet is set
	if !noTUI && !quiet {
		runTUIInstall()
		return
	}

	// Fall back to CLI mode
	plat := platform.Detect()
	if !quiet {
		fmt.Printf("Detected platform: %s\n", plat)
	}

	cache, err := download.NewCache()
	if err != nil {
		exitcodes.ExitError(exitcodes.ErrGeneral, fmt.Errorf("initialize cache: %w", err))
	}

	ch := config.Channel(channel)
	var rel *config.Release

	if version != "" {
		// User requested a specific version; find it in the release list.
		releases, err := config.FetchReleasesRefresh(cache, ch)
		if err != nil {
			exitcodes.ExitError(exitcodes.ErrNetwork, fmt.Errorf("fetch releases: %w", err))
		}
		for _, r := range releases {
			if r.Version == version || r.Version == strings.TrimPrefix(version, "v") {
				r := r
				rel = &r
				break
			}
		}
		if rel == nil {
			exitcodes.Exit(exitcodes.ErrGeneral, fmt.Sprintf("version %q not found in channel %q", version, channel))
		}
	} else {
		rel, err = config.GetLatestRefresh(cache, ch)
		if err != nil {
			exitcodes.ExitError(exitcodes.ErrNetwork, fmt.Errorf("fetch latest release: %w", err))
		}
	}

	// Check if already at this version
	destPath, err := resolveInstallPath()
	if err != nil {
		exitcodes.ExitError(exitcodes.ErrGeneral, err)
	}

	if _, err := os.Stat(destPath); err == nil {
		current := installedVersion(destPath)
		if current == rel.Version || current == "v"+rel.Version {
			if !quiet {
				fmt.Printf("Already at version %s\n", current)
			}
			return
		}
		if !quiet {
			fmt.Printf("Updating veil from %s to %s\n", current, rel.Version)
		}
	} else if !quiet {
		fmt.Printf("Installing veil %s\n", rel.Version)
	}

	// Get platform-specific download URL.
	assetKey := plat.AssetKey()
	downloadURL, ok := rel.GetAssetURL(assetKey)
	if !ok {
		exitcodes.Exit(exitcodes.ErrGeneral, fmt.Sprintf("no binary available for platform %q (asset key: %s)", plat, assetKey))
	}

	client, err := newDownloadClient()
	if err != nil {
		exitcodes.ExitError(exitcodes.ErrGeneral, err)
	}

	// Download binary to a temp file.
	tmpBin, err := os.CreateTemp("", "veil-download-*.tmp")
	if err != nil {
		exitcodes.ExitError(exitcodes.ErrGeneral, fmt.Errorf("create temp file: %w", err))
	}
	tmpBinPath := tmpBin.Name()
	tmpBin.Close()
	defer os.Remove(tmpBinPath)

	if !quiet {
		fmt.Printf("Downloading from %s\n", downloadURL)
	}

	ctx := context.Background()
	if err := client.Download(ctx, downloadURL, tmpBinPath, nil); err != nil {
		exitcodes.ExitError(exitcodes.ErrNetwork, fmt.Errorf("download binary: %w", err))
	}

	// Verify checksum if available.
	if rel.Checksum != "" {
		if !quiet {
			fmt.Println("Verifying checksum...")
		}

		tmpSum, err := os.CreateTemp("", "veil-checksums-*.tmp")
		if err != nil {
			exitcodes.ExitError(exitcodes.ErrGeneral, fmt.Errorf("create checksum temp file: %w", err))
		}
		tmpSumPath := tmpSum.Name()
		tmpSum.Close()
		defer os.Remove(tmpSumPath)

		if err := client.Download(ctx, rel.Checksum, tmpSumPath, nil); err != nil {
			exitcodes.ExitError(exitcodes.ErrNetwork, fmt.Errorf("download checksum: %w", err))
		}

		checksumData, err := os.ReadFile(tmpSumPath)
		if err != nil {
			exitcodes.ExitError(exitcodes.ErrGeneral, fmt.Errorf("read checksum file: %w", err))
		}

		checksums, err := verify.ParseChecksums(string(checksumData))
		if err != nil {
			exitcodes.ExitError(exitcodes.ErrVerification, fmt.Errorf("parse checksum file: %w", err))
		}

		binFile, err := os.Open(tmpBinPath)
		if err != nil {
			exitcodes.ExitError(exitcodes.ErrGeneral, fmt.Errorf("open binary for verification: %w", err))
		}

		// Match by binary filename suffix.
		var expectedSum []byte
		for name, sum := range checksums {
			if strings.Contains(name, plat.String()) || strings.HasSuffix(name, "veil") {
				expectedSum = sum
				break
			}
		}

		if expectedSum != nil {
			if err := verify.VerifyChecksum(binFile, expectedSum); err != nil {
				binFile.Close()
				exitcodes.ExitError(exitcodes.ErrVerification, fmt.Errorf("checksum verification failed: %w", err))
			}
		}
		binFile.Close()
	}

	// Backup existing installation if present.
	if _, err := os.Stat(destPath); err == nil {
		bDir, err := backupDir()
		if err == nil {
			currentVer := installedVersion(destPath)
			if _, berr := install.Backup(destPath, bDir, currentVer); berr != nil && !quiet {
				fmt.Fprintf(os.Stderr, "Warning: could not backup existing binary: %v\n", berr)
			}
		}
	}

	// Install binary - extract from archive if needed.
	if err := os.MkdirAll(filepath.Dir(destPath), 0o755); err != nil {
		if errors.Is(err, os.ErrPermission) {
			exitcodes.ExitError(exitcodes.ErrPermission, fmt.Errorf("create install directory: %w", err))
		}
		exitcodes.ExitError(exitcodes.ErrGeneral, fmt.Errorf("create install directory: %w", err))
	}

	// Check if the download is an archive (based on URL) and extract accordingly.
	if strings.HasSuffix(downloadURL, ".tar.gz") || strings.HasSuffix(downloadURL, ".zip") {
		if err := install.InstallFromArchive(tmpBinPath, destPath); err != nil {
			if errors.Is(err, os.ErrPermission) {
				exitcodes.ExitError(exitcodes.ErrPermission, fmt.Errorf("install from archive: %w", err))
			}
			exitcodes.ExitError(exitcodes.ErrGeneral, fmt.Errorf("install from archive: %w", err))
		}
	} else {
		binFile, err := os.Open(tmpBinPath)
		if err != nil {
			exitcodes.ExitError(exitcodes.ErrGeneral, fmt.Errorf("open downloaded binary: %w", err))
		}
		defer binFile.Close()

		if err := install.Install(binFile, destPath); err != nil {
			if errors.Is(err, os.ErrPermission) {
				exitcodes.ExitError(exitcodes.ErrPermission, fmt.Errorf("install binary: %w", err))
			}
			exitcodes.ExitError(exitcodes.ErrGeneral, fmt.Errorf("install binary: %w", err))
		}
	}

	// Write version file.
	versionFile := filepath.Join(filepath.Dir(destPath), ".veil-version")
	_ = os.WriteFile(versionFile, []byte(rel.Version), 0o644)

	if !quiet {
		fmt.Printf("Installed veil %s to %s\n", rel.Version, destPath)
	}

	// Modify PATH.
	if !noModifyPath {
		shell := platform.DetectShell()
		shellCfg := platform.GetShellConfig(shell)
		if err := install.ModifyPATH(shellCfg, filepath.Dir(destPath)); err != nil && !quiet {
			fmt.Fprintf(os.Stderr, "Warning: could not modify PATH in %s: %v\n", shellCfg.RCFile, err)
		} else if !quiet {
			fmt.Printf("Added %s to PATH in %s\n", filepath.Dir(destPath), shellCfg.RCFile)
		}
	}

	// Install completions.
	if !noCompletions {
		shell := platform.DetectShell()
		if err := install.InstallCompletions(destPath, shell); err != nil && !quiet {
			fmt.Fprintf(os.Stderr, "Warning: could not install completions: %v\n", err)
		} else if !quiet {
			fmt.Printf("Installed %s completions\n", shell)
		}
	}
}

func runUpdate(cmd *cobra.Command, args []string) {
	// Self-update the installer first (defaults to yes)
	doSelfUpdate(true)

	destPath, err := resolveInstallPath()
	if err != nil {
		exitcodes.ExitError(exitcodes.ErrGeneral, err)
	}

	// Treat a missing binary as "not installed" for the update command.
	if _, err := os.Stat(destPath); os.IsNotExist(err) {
		exitcodes.Exit(exitcodes.ErrNotInstalled, fmt.Sprintf("veil is not installed at %s; run 'install' first", destPath))
	}

	current := installedVersion(destPath)

	cache, err := download.NewCache()
	if err != nil {
		exitcodes.ExitError(exitcodes.ErrGeneral, fmt.Errorf("initialize cache: %w", err))
	}

	ch := config.Channel(channel)
	latest, err := config.GetLatestRefresh(cache, ch)
	if err != nil {
		exitcodes.ExitError(exitcodes.ErrNetwork, fmt.Errorf("fetch latest release: %w", err))
	}

	if config.CompareVersions(latest.Version, current) <= 0 {
		if !quiet {
			fmt.Printf("Already at the latest version (%s)\n", current)
		}
		exitcodes.Exit(exitcodes.ErrAlreadyInstalled, "")
	}

	if !quiet {
		fmt.Printf("Updating veil from %s to %s\n", current, latest.Version)
	}

	// Delegate to install logic with the resolved path.
	savedPath := path
	path = destPath
	savedVersion := version
	version = latest.Version
	runInstall(cmd, args)
	path = savedPath
	version = savedVersion
}

func runUninstall(cmd *cobra.Command, args []string) {
	destPath, err := resolveInstallPath()
	if err != nil {
		exitcodes.ExitError(exitcodes.ErrGeneral, err)
	}

	if _, err := os.Stat(destPath); os.IsNotExist(err) {
		exitcodes.Exit(exitcodes.ErrNotInstalled, fmt.Sprintf("veil is not installed at %s", destPath))
	}

	if !yes {
		fmt.Printf("Remove veil from %s? [y/N] ", destPath)
		var answer string
		fmt.Scanln(&answer)
		if strings.ToLower(strings.TrimSpace(answer)) != "y" {
			fmt.Println("Aborted.")
			exitcodes.Exit(exitcodes.ErrUserCancelled, "")
		}
	}

	if err := os.Remove(destPath); err != nil {
		if errors.Is(err, os.ErrPermission) {
			exitcodes.ExitError(exitcodes.ErrPermission, fmt.Errorf("remove binary: %w", err))
		}
		exitcodes.ExitError(exitcodes.ErrGeneral, fmt.Errorf("remove binary: %w", err))
	}
	if !quiet {
		fmt.Printf("Removed %s\n", destPath)
	}

	// Remove version file.
	versionFile := filepath.Join(filepath.Dir(destPath), ".veil-version")
	_ = os.Remove(versionFile)

	// Remove completions for the detected shell.
	shell := platform.DetectShell()
	if err := install.RemoveCompletions(shell); err != nil && !quiet {
		fmt.Fprintf(os.Stderr, "Warning: could not remove completions: %v\n", err)
	}

	if purge {
		home, _ := os.UserHomeDir()
		configDir := filepath.Join(home, ".config", "veil")
		dataDir := filepath.Join(home, ".local", "share", "veil")

		for _, dir := range []string{configDir, dataDir} {
			if err := os.RemoveAll(dir); err != nil && !quiet {
				fmt.Fprintf(os.Stderr, "Warning: could not remove %s: %v\n", dir, err)
			} else if !quiet {
				fmt.Printf("Removed %s\n", dir)
			}
		}
	}

	if !quiet {
		fmt.Println("Veil has been uninstalled.")
	}
}

func runInfo(cmd *cobra.Command, args []string) {
	destPath, err := resolveInstallPath()
	if err != nil {
		exitcodes.ExitError(exitcodes.ErrGeneral, err)
	}

	plat := platform.Detect()

	fmt.Printf("Platform:    %s\n", plat)

	if _, err := os.Stat(destPath); os.IsNotExist(err) {
		fmt.Println("Status:      not installed")
		return
	}

	ver := installedVersion(destPath)
	fmt.Printf("Status:      installed\n")
	fmt.Printf("Version:     %s\n", ver)
	fmt.Printf("Path:        %s\n", destPath)
	fmt.Printf("Channel:     %s\n", channel)

	shell := platform.DetectShell()
	shellCfg := platform.GetShellConfig(shell)
	fmt.Printf("Shell:       %s\n", shell)
	fmt.Printf("PATH set:    %v\n", install.IsPathConfigured(shellCfg))

	completionPath := install.GetCompletionPath(shell)
	if completionPath != "" {
		_, statErr := os.Stat(completionPath)
		fmt.Printf("Completions: %v (%s)\n", statErr == nil, completionPath)
	}

	bDir, err := backupDir()
	if err == nil {
		backups, err := install.ListBackups(bDir)
		if err == nil && len(backups) > 0 {
			fmt.Printf("Backups:     %d (latest: %s)\n", len(backups), backups[0].Version)
		}
	}
}

func runReleases(cmd *cobra.Command, args []string) {
	cache, err := download.NewCache()
	if err != nil {
		exitcodes.ExitError(exitcodes.ErrGeneral, fmt.Errorf("initialize cache: %w", err))
	}

	ch := config.Channel(channel)
	releases, err := config.FetchReleasesRefresh(cache, ch)
	if err != nil {
		exitcodes.ExitError(exitcodes.ErrNetwork, fmt.Errorf("fetch releases: %w", err))
	}

	if len(releases) == 0 {
		fmt.Printf("No releases found for channel %q\n", channel)
		return
	}

	fmt.Printf("Available releases (channel: %s):\n", channel)
	for _, r := range releases {
		fmt.Printf("  %s\n", r.Version)
	}
}

// runTUIInstall runs the interactive bubbletea TUI installer.
func runTUIInstall() {
	model := app.New(app.Options{
		Version:      version,
		Yes:          yes,
		Channel:      channel,
		Path:         path,
		NoModifyPath: noModifyPath,
		NoComplete:   noCompletions,
		ProxyURL:     proxyURL,
		CACert:       caCert,
	})

	p := tea.NewProgram(model)
	if _, err := p.Run(); err != nil {
		exitcodes.ExitError(exitcodes.ErrGeneral, err)
	}
}

// runAirgapInstall handles --binary and --archive flags for offline installs.
func runAirgapInstall(_ *cobra.Command, _ []string) {
	if localBinary != "" && localArchive != "" {
		exitcodes.Exit(exitcodes.ErrGeneral, "--binary and --archive are mutually exclusive")
	}

	destPath, err := resolveInstallPath()
	if err != nil {
		exitcodes.ExitError(exitcodes.ErrGeneral, err)
	}

	// Backup existing installation if present.
	if _, err := os.Stat(destPath); err == nil {
		bDir, err := backupDir()
		if err == nil {
			currentVer := installedVersion(destPath)
			if _, berr := install.Backup(destPath, bDir, currentVer); berr != nil && !quiet {
				fmt.Fprintf(os.Stderr, "Warning: could not backup existing binary: %v\n", berr)
			}
		}
	}

	switch {
	case localBinary != "":
		if !quiet {
			fmt.Printf("Installing from local binary: %s\n", localBinary)
		}
		if err := install.InstallFromBinary(localBinary, destPath); err != nil {
			if errors.Is(err, os.ErrPermission) {
				exitcodes.ExitError(exitcodes.ErrPermission, fmt.Errorf("install from binary: %w", err))
			}
			exitcodes.ExitError(exitcodes.ErrGeneral, fmt.Errorf("install from binary: %w", err))
		}
	case localArchive != "":
		if !quiet {
			fmt.Printf("Installing from local archive: %s\n", localArchive)
		}
		if err := install.InstallFromArchive(localArchive, destPath); err != nil {
			if errors.Is(err, os.ErrPermission) {
				exitcodes.ExitError(exitcodes.ErrPermission, fmt.Errorf("install from archive: %w", err))
			}
			exitcodes.ExitError(exitcodes.ErrGeneral, fmt.Errorf("install from archive: %w", err))
		}
	}

	if !quiet {
		fmt.Printf("Installed veil to %s\n", destPath)
	}

	// Modify PATH.
	if !noModifyPath {
		shell := platform.DetectShell()
		shellCfg := platform.GetShellConfig(shell)
		if err := install.ModifyPATH(shellCfg, filepath.Dir(destPath)); err != nil && !quiet {
			fmt.Fprintf(os.Stderr, "Warning: could not modify PATH in %s: %v\n", shellCfg.RCFile, err)
		} else if !quiet {
			fmt.Printf("Added %s to PATH in %s\n", filepath.Dir(destPath), shellCfg.RCFile)
		}
	}

	// Install completions.
	if !noCompletions {
		shell := platform.DetectShell()
		if err := install.InstallCompletions(destPath, shell); err != nil && !quiet {
			fmt.Fprintf(os.Stderr, "Warning: could not install completions: %v\n", err)
		} else if !quiet {
			fmt.Printf("Installed %s completions\n", shell)
		}
	}
}

func runSelfUpdate(cmd *cobra.Command, args []string) {
	doSelfUpdate(false)
}

// doSelfUpdate updates the installer itself. Returns true if an update was performed.
// If asPrereq is true, this is being called as part of `update` and should be quieter.
func doSelfUpdate(asPrereq bool) bool {
	installerRelease, err := config.GetInstallerRelease()
	if err != nil {
		if !asPrereq && !quiet {
			fmt.Printf("Warning: could not fetch installer release info: %v\n", err)
		}
		return false
	}

	if installerRelease == nil {
		if !asPrereq && !quiet {
			fmt.Println("No installer release info available.")
		}
		return false
	}

	// Compare versions
	if config.CompareVersions(installerRelease.Version, InstallerVersion) <= 0 {
		if !asPrereq && !quiet {
			fmt.Printf("Installer is up to date (%s)\n", InstallerVersion)
		}
		return false
	}

	// Get current platform
	plat := platform.Detect()
	assetURL, ok := installerRelease.GetAssetURL(plat.AssetKey())
	if !ok {
		if !asPrereq && !quiet {
			fmt.Printf("No installer binary available for %s\n", plat.AssetKey())
		}
		return false
	}

	if !quiet {
		fmt.Printf("Installer update available: %s -> %s\n", InstallerVersion, installerRelease.Version)
	}

	// Default to yes for self-update
	if !yes && !asPrereq {
		fmt.Print("Update installer? [Y/n] ")
		var answer string
		fmt.Scanln(&answer)
		answer = strings.ToLower(strings.TrimSpace(answer))
		if answer == "n" || answer == "no" {
			fmt.Println("Skipped installer update.")
			return false
		}
	}

	// Download new installer
	client, err := newDownloadClient()
	if err != nil {
		exitcodes.ExitError(exitcodes.ErrGeneral, fmt.Errorf("create download client: %w", err))
	}

	if !quiet {
		fmt.Printf("Downloading installer %s...\n", installerRelease.Version)
	}

	tmpFile, err := os.CreateTemp("", "veil-installer-*.tmp")
	if err != nil {
		exitcodes.ExitError(exitcodes.ErrGeneral, fmt.Errorf("create temp file: %w", err))
	}
	tmpPath := tmpFile.Name()
	tmpFile.Close()

	if err := client.Download(context.Background(), assetURL, tmpPath, nil); err != nil {
		os.Remove(tmpPath)
		exitcodes.ExitError(exitcodes.ErrNetwork, fmt.Errorf("download installer: %w", err))
	}

	// Make executable
	if err := os.Chmod(tmpPath, 0o755); err != nil {
		os.Remove(tmpPath)
		exitcodes.ExitError(exitcodes.ErrGeneral, fmt.Errorf("chmod: %w", err))
	}

	// Find current installer path
	home, err := os.UserHomeDir()
	if err != nil {
		os.Remove(tmpPath)
		exitcodes.ExitError(exitcodes.ErrGeneral, fmt.Errorf("resolve home: %w", err))
	}
	installerPath := filepath.Join(home, ".local", "bin", "veil-installer")

	// Replace installer
	if err := os.MkdirAll(filepath.Dir(installerPath), 0o755); err != nil {
		os.Remove(tmpPath)
		exitcodes.ExitError(exitcodes.ErrGeneral, fmt.Errorf("create dir: %w", err))
	}

	if err := os.Rename(tmpPath, installerPath); err != nil {
		os.Remove(tmpPath)
		exitcodes.ExitError(exitcodes.ErrGeneral, fmt.Errorf("replace installer: %w", err))
	}

	if !quiet {
		fmt.Printf("Installer updated to %s\n", installerRelease.Version)
	}
	return true
}

func runCheck(cmd *cobra.Command, args []string) {
	destPath, err := resolveInstallPath()
	if err != nil {
		exitcodes.ExitError(exitcodes.ErrGeneral, err)
	}

	cache, err := download.NewCache()
	if err != nil {
		exitcodes.ExitError(exitcodes.ErrGeneral, fmt.Errorf("initialize cache: %w", err))
	}

	ch := config.Channel(channel)
	hasUpdate := false

	if !quiet {
		fmt.Println()
		fmt.Println("  Veil Health Check")
		fmt.Println("  =================")
		fmt.Println()
	}

	// Check installer version
	installerRelease, _ := config.GetInstallerRelease()
	installerStatus := "up to date"
	installerLatest := InstallerVersion
	if installerRelease != nil {
		installerLatest = installerRelease.Version
		if config.CompareVersions(installerRelease.Version, InstallerVersion) > 0 {
			installerStatus = "update available"
			hasUpdate = true
		}
	}
	if !quiet {
		fmt.Printf("  Installer:    %s", InstallerVersion)
		if installerStatus == "update available" {
			fmt.Printf(" -> %s available", installerLatest)
		} else {
			fmt.Printf(" (latest)")
		}
		fmt.Println()
	}

	// Check veil version
	veilInstalled := false
	current := "not installed"
	if _, err := os.Stat(destPath); err == nil {
		current = installedVersion(destPath)
		veilInstalled = true
	}

	latest, err := config.GetLatestRefresh(cache, ch)
	if err != nil {
		exitcodes.ExitError(exitcodes.ErrNetwork, fmt.Errorf("fetch latest release: %w", err))
	}

	veilStatus := "up to date"
	if !veilInstalled {
		veilStatus = "not installed"
	} else if config.CompareVersions(latest.Version, current) > 0 {
		veilStatus = "update available"
		hasUpdate = true
	}

	if !quiet {
		fmt.Printf("  Veil CLI:     %s", current)
		if veilStatus == "update available" {
			fmt.Printf(" -> %s available", latest.Version)
		} else if veilInstalled {
			fmt.Printf(" (latest)")
		}
		fmt.Println()
		fmt.Printf("  Channel:      %s\n", ch)
		fmt.Printf("  Path:         %s\n", destPath)
	}

	// Check extensions
	if veilInstalled {
		home, _ := os.UserHomeDir()
		extensionsDir := filepath.Join(home, ".veil", "extensions")
		agentsDir := filepath.Join(home, ".veil", "agents")

		extCount := countFiles(extensionsDir, ".ts", ".js")
		agentCount := countFiles(agentsDir, ".md")

		if !quiet {
			fmt.Printf("  Extensions:   %d custom\n", extCount)
			fmt.Printf("  Agents:       %d custom\n", agentCount)
		}
	}

	// Check shell integration
	if veilInstalled && !quiet {
		shell := platform.DetectShell()
		shellCfg := platform.GetShellConfig(shell)
		pathOk := install.IsPathConfigured(shellCfg)
		completionPath := install.GetCompletionPath(shell)
		completionsOk := false
		if completionPath != "" {
			_, statErr := os.Stat(completionPath)
			completionsOk = statErr == nil
		}

		fmt.Println()
		fmt.Printf("  Shell:        %s\n", shell)
		fmt.Printf("  PATH:         %s\n", boolStatus(pathOk))
		fmt.Printf("  Completions:  %s\n", boolStatus(completionsOk))
	}

	if !quiet {
		fmt.Println()
		if hasUpdate {
			fmt.Println("  Run 'veil-installer update' to update.")
		} else if veilInstalled {
			fmt.Println("  Everything looks good!")
		} else {
			fmt.Println("  Run 'veil-installer install' to install Veil.")
		}
		fmt.Println()
	}

	if hasUpdate {
		os.Exit(10)
	}
}

func boolStatus(ok bool) string {
	if ok {
		return "configured"
	}
	return "not configured"
}

func countFiles(dir string, exts ...string) int {
	count := 0
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		for _, ext := range exts {
			if strings.HasSuffix(name, ext) {
				count++
				break
			}
		}
	}
	return count
}

func runEmbedderCacheClear(cmd *cobra.Command, args []string) {
	home, err := os.UserHomeDir()
	if err != nil {
		exitcodes.ExitError(exitcodes.ErrGeneral, fmt.Errorf("resolve home directory: %w", err))
	}

	cacheDir := filepath.Join(home, ".cache", "veil", "models")

	info, err := os.Stat(cacheDir)
	if os.IsNotExist(err) {
		if !quiet {
			fmt.Println("No cached models found.")
		}
		return
	}
	if err != nil {
		exitcodes.ExitError(exitcodes.ErrGeneral, fmt.Errorf("stat cache directory: %w", err))
	}
	if !info.IsDir() {
		exitcodes.Exit(exitcodes.ErrGeneral, fmt.Sprintf("%s is not a directory", cacheDir))
	}

	var totalSize int64
	var fileCount int
	filepath.Walk(cacheDir, func(_ string, info os.FileInfo, _ error) error {
		if info != nil && !info.IsDir() {
			totalSize += info.Size()
			fileCount++
		}
		return nil
	})

	if fileCount == 0 {
		if !quiet {
			fmt.Println("No cached models found.")
		}
		return
	}

	sizeStr := formatBytes(totalSize)
	if !yes {
		fmt.Printf("Clear %d cached model files (%s) from %s? [y/N] ", fileCount, sizeStr, cacheDir)
		var answer string
		fmt.Scanln(&answer)
		if strings.ToLower(strings.TrimSpace(answer)) != "y" {
			fmt.Println("Aborted.")
			exitcodes.Exit(exitcodes.ErrUserCancelled, "")
		}
	}

	if err := os.RemoveAll(cacheDir); err != nil {
		if errors.Is(err, os.ErrPermission) {
			exitcodes.ExitError(exitcodes.ErrPermission, fmt.Errorf("remove cache directory: %w", err))
		}
		exitcodes.ExitError(exitcodes.ErrGeneral, fmt.Errorf("remove cache directory: %w", err))
	}

	if !quiet {
		fmt.Printf("Cleared %d cached model files (%s).\n", fileCount, sizeStr)
	}
}

// ensureInstallerInstalled copies the running binary to ~/.local/bin/veil-installer
// if not already there, or updates it if the running binary is newer.
func ensureInstallerInstalled() {
	exePath, err := os.Executable()
	if err != nil {
		return // silently fail, not critical
	}

	exePath, err = filepath.EvalSymlinks(exePath)
	if err != nil {
		return
	}

	home, err := os.UserHomeDir()
	if err != nil {
		return
	}

	destDir := filepath.Join(home, ".local", "bin")
	destPath := filepath.Join(destDir, "veil-installer")

	// Already running from installed location
	if exePath == destPath {
		return
	}

	// Check if we need to install or update
	srcInfo, err := os.Stat(exePath)
	if err != nil {
		return
	}

	needsInstall := false
	if destInfo, err := os.Stat(destPath); os.IsNotExist(err) {
		needsInstall = true
	} else if err == nil && srcInfo.ModTime().After(destInfo.ModTime()) {
		// Source is newer, update
		needsInstall = true
	}

	if !needsInstall {
		return
	}

	// Create destination directory
	if err := os.MkdirAll(destDir, 0o755); err != nil {
		return
	}

	// Copy executable
	srcFile, err := os.Open(exePath)
	if err != nil {
		return
	}
	defer srcFile.Close()

	tmpFile, err := os.CreateTemp(destDir, "veil-installer-*.tmp")
	if err != nil {
		return
	}
	tmpPath := tmpFile.Name()

	if _, err := tmpFile.ReadFrom(srcFile); err != nil {
		tmpFile.Close()
		os.Remove(tmpPath)
		return
	}
	tmpFile.Close()

	if err := os.Chmod(tmpPath, 0o755); err != nil {
		os.Remove(tmpPath)
		return
	}

	if err := os.Rename(tmpPath, destPath); err != nil {
		os.Remove(tmpPath)
		return
	}

	// Add to PATH if needed
	shell := platform.DetectShell()
	shellCfg := platform.GetShellConfig(shell)
	_ = install.ModifyPATH(shellCfg, destDir)
}

func formatBytes(b int64) string {
	const unit = 1024
	if b < unit {
		return fmt.Sprintf("%d B", b)
	}
	div, exp := int64(unit), 0
	for n := b / unit; n >= unit; n /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %cB", float64(b)/float64(div), "KMGTPE"[exp])
}
