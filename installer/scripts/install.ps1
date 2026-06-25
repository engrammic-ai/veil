# Veil bootstrap installer for Windows
# Usage:
#   irm https://veil.engrammic.ai/install.ps1 | iex
#   $env:VEIL_VERSION="v1.2.3"; irm https://veil.engrammic.ai/install.ps1 | iex
#
# Downloads the correct installer binary for your platform, verifies its
# SHA256 checksum, and runs it.

$ErrorActionPreference = "Stop"

$Repo = "engrammic-ai/veil"
$ReleasesUrl = "https://github.com/$Repo/releases"
$ApiUrl = "https://api.github.com/repos/$Repo/releases/latest"

function Write-Info { param($msg) Write-Host "info  $msg" -ForegroundColor Blue }
function Write-Ok { param($msg) Write-Host "ok    $msg" -ForegroundColor Green }
function Write-Warn { param($msg) Write-Host "warn  $msg" -ForegroundColor Yellow }
function Write-Err { param($msg) Write-Host "error $msg" -ForegroundColor Red; exit 1 }

function Get-Platform {
    # ponytail: $env:PROCESSOR_ARCHITECTURE works on PowerShell 5.1+, no .NET Core needed
    $arch = $env:PROCESSOR_ARCHITECTURE
    switch ($arch) {
        "AMD64" { return "windows-x64" }
        "ARM64" { return "windows-arm64" }
        "x86"   { Write-Err "32-bit Windows is not supported" }
        default { Write-Err "Unsupported architecture: $arch" }
    }
}

function Get-LatestVersion {
    try {
        $response = Invoke-RestMethod -Uri $ApiUrl -UseBasicParsing
        return $response.tag_name
    } catch {
        Write-Err "Failed to fetch latest release: $_"
    }
}

function Get-InstallerBinary {
    param($Platform, $Version, $TempDir)

    $binaryName = "veil-installer-$Platform.exe"
    $binaryUrl = "$ReleasesUrl/download/$Version/$binaryName"
    $checksumsUrl = "$ReleasesUrl/download/$Version/checksums.sha256"
    $destPath = Join-Path $TempDir $binaryName

    Write-Info "Downloading installer for $Platform ($Version)..."
    try {
        Invoke-WebRequest -Uri $binaryUrl -OutFile $destPath -UseBasicParsing
        Write-Ok "Download complete."
    } catch {
        Write-Err "Download failed: $_`nURL: $binaryUrl"
    }

    # Verify checksum
    Write-Info "Verifying checksum..."
    try {
        $checksumContent = (Invoke-WebRequest -Uri $checksumsUrl -UseBasicParsing).Content
        $lines = $checksumContent -split "`n"
        $expectedSum = $null
        foreach ($line in $lines) {
            if ($line -match "^([a-f0-9]+)\s+.*$binaryName") {
                $expectedSum = $Matches[1]
                break
            }
        }

        if ($expectedSum) {
            $actualSum = (Get-FileHash -Path $destPath -Algorithm SHA256).Hash.ToLower()
            if ($actualSum -ne $expectedSum) {
                Write-Err "Checksum mismatch!`n  expected: $expectedSum`n  got:      $actualSum"
            }
            Write-Ok "Checksum verified."
        } else {
            Write-Warn "No checksum found for $binaryName"
        }
    } catch {
        Write-Warn "Could not verify checksum: $_"
    }

    return $destPath
}

function Main {
    Write-Host ""
    Write-Host "  Veil Installer"
    Write-Host "  https://veil.engrammic.ai"
    Write-Host ""

    $platform = Get-Platform
    Write-Ok "Platform: $platform"

    $version = $env:VEIL_VERSION
    if (-not $version) {
        Write-Info "Fetching latest release..."
        $version = Get-LatestVersion
    }
    Write-Ok "Version:  $version"

    $tempDir = Join-Path $env:TEMP "veil-install-$(Get-Random)"
    New-Item -ItemType Directory -Path $tempDir -Force | Out-Null

    try {
        $installerPath = Get-InstallerBinary -Platform $platform -Version $version -TempDir $tempDir

        # Strip 'v' prefix for semver
        $versionArg = $version -replace '^v', ''

        Write-Host ""
        Write-Info "Running installer..."
        Write-Host ""

        & $installerPath --install-version $versionArg
    } finally {
        if (Test-Path $tempDir) {
            Remove-Item -Path $tempDir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

Main
