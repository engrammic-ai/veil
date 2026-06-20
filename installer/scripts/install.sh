#!/bin/sh
# Veil bootstrap installer
# Usage:
#   curl -fsSL https://veil.engrammic.ai/install | sh
#   curl -fsSL https://veil.engrammic.ai/install | VEIL_VERSION=v1.2.3 sh
#   curl -fsSL https://veil.engrammic.ai/install | VEIL_INSTALL_DIR=/usr/local/bin sh
#
# Downloads the correct installer binary for your platform, verifies its
# SHA256 checksum, and runs it. The installer binary handles all further
# setup (PATH wiring, shell completions, etc.).
#
# Environment variables:
#   VEIL_VERSION      Pin a specific release tag (e.g. "v1.2.3"). Defaults
#                     to the latest published GitHub release.
#   VEIL_INSTALL_DIR  Directory to place the veil binary. Defaults to
#                     $HOME/.local/bin on Linux/macOS.
#
# Requirements: sh (POSIX), curl or wget, sha256sum or shasum.

set -e

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
REPO="engrammic-ai/veil"
RELEASES_URL="https://github.com/${REPO}/releases"
API_URL="https://api.github.com/repos/${REPO}/releases/latest"

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------
_tty_colors() {
    if [ -t 1 ]; then
        RED='\033[0;31m'
        GRN='\033[0;32m'
        YLW='\033[0;33m'
        BLU='\033[0;34m'
        RST='\033[0m'
    else
        RED='' GRN='' YLW='' BLU='' RST=''
    fi
}

info()  { printf "${BLU}info${RST}  %s\n"  "$1" >&2; }
ok()    { printf "${GRN}ok${RST}    %s\n"  "$1" >&2; }
warn()  { printf "${YLW}warn${RST}  %s\n"  "$1" >&2; }
die()   { printf "${RED}error${RST} %s\n" "$1" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Temp-dir cleanup on exit
# ---------------------------------------------------------------------------
_TMPDIR=""

_cleanup() {
    if [ -n "$_TMPDIR" ] && [ -d "$_TMPDIR" ]; then
        rm -rf "$_TMPDIR"
    fi
}

trap _cleanup EXIT INT TERM

_mktmpdir() {
    _TMPDIR="$(mktemp -d 2>/dev/null || mktemp -d -t veil-install)"
    printf '%s' "$_TMPDIR"
}

# ---------------------------------------------------------------------------
# Dependency checks
# ---------------------------------------------------------------------------
_require_cmd() {
    command -v "$1" >/dev/null 2>&1
}

_check_deps() {
    if ! _require_cmd curl && ! _require_cmd wget; then
        die "curl or wget is required to download Veil. Please install one and retry."
    fi
}

# ---------------------------------------------------------------------------
# HTTP fetch (curl with wget fallback)
# ---------------------------------------------------------------------------
_fetch() {
    _fetch_url="$1"
    _fetch_out="$2"   # path, or "-" for stdout

    if _require_cmd curl; then
        if [ "$_fetch_out" = "-" ]; then
            curl -fsSL "$_fetch_url"
        else
            curl -fsSL --retry 3 --retry-delay 2 -o "$_fetch_out" "$_fetch_url"
        fi
    else
        if [ "$_fetch_out" = "-" ]; then
            wget -qO- "$_fetch_url"
        else
            wget -q --tries=3 -O "$_fetch_out" "$_fetch_url"
        fi
    fi
}

# ---------------------------------------------------------------------------
# Platform detection
# ---------------------------------------------------------------------------
_detect_os() {
    _uname="$(uname -s)"
    case "$_uname" in
        Linux*)  printf 'linux'  ;;
        Darwin*) printf 'darwin' ;;
        *)       die "Unsupported operating system: $_uname. Only Linux and macOS are supported." ;;
    esac
}

_detect_arch() {
    _machine="$(uname -m)"
    case "$_machine" in
        x86_64|amd64)   printf 'x64'   ;;
        arm64|aarch64)  printf 'arm64' ;;
        *)              die "Unsupported architecture: $_machine. Only x86_64 and arm64 are supported." ;;
    esac
}

_detect_platform() {
    _os="$(_detect_os)"
    _arch="$(_detect_arch)"
    printf '%s-%s' "$_os" "$_arch"
}

# ---------------------------------------------------------------------------
# Version resolution
# ---------------------------------------------------------------------------
_latest_version() {
    _json="$(_fetch "$API_URL" -)" || die "Could not reach GitHub API. Check your network connection."
    printf '%s' "$_json" \
        | grep '"tag_name"' \
        | head -n1 \
        | sed 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/'
}

# ---------------------------------------------------------------------------
# Checksum verification
# ---------------------------------------------------------------------------
_sha256sum_cmd() {
    if _require_cmd sha256sum; then
        printf 'sha256sum'
    elif _require_cmd shasum; then
        printf 'shasum -a 256'
    else
        printf ''
    fi
}

_verify_checksum() {
    _vc_file="$1"
    _vc_expected="$2"

    _sum_cmd="$(_sha256sum_cmd)"
    if [ -z "$_sum_cmd" ]; then
        warn "No sha256sum or shasum found - skipping checksum verification."
        return 0
    fi

    _actual="$(eval "$_sum_cmd" "$_vc_file" | awk '{print $1}')"
    if [ "$_actual" != "$_vc_expected" ]; then
        die "Checksum mismatch for $(basename "$_vc_file").
  expected: $_vc_expected
  got:      $_actual"
    fi
}

# ---------------------------------------------------------------------------
# Download + verify installer binary
# ---------------------------------------------------------------------------
_download_installer() {
    _dl_platform="$1"
    _dl_version="$2"
    _dl_tmpdir="$3"

    _dl_base="veil-installer-${_dl_platform}"
    _dl_url="${RELEASES_URL}/download/${_dl_version}/${_dl_base}"
    _dl_dest="${_dl_tmpdir}/${_dl_base}"
    _dl_checksums_url="${RELEASES_URL}/download/${_dl_version}/checksums.sha256"

    info "Downloading installer for ${_dl_platform} (${_dl_version})..."
    _fetch "$_dl_url" "$_dl_dest" || die "Download failed: $_dl_url"
    ok "Download complete."

    # Verify checksum from consolidated checksums.sha256 file
    _dl_checksums="${_dl_tmpdir}/checksums.sha256"
    info "Verifying checksum..."
    if _fetch "$_dl_checksums_url" "$_dl_checksums" 2>/dev/null; then
        _expected="$(grep "${_dl_base}" "$_dl_checksums" | awk '{print $1}')"
        if [ -n "$_expected" ]; then
            _verify_checksum "$_dl_dest" "$_expected"
            ok "Checksum verified."
        else
            warn "No checksum found for ${_dl_base} in checksums.sha256"
        fi
    else
        warn "checksums.sha256 not found - skipping verification."
    fi

    chmod +x "$_dl_dest"
    printf '%s' "$_dl_dest"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
    printf '\n'
    printf '  Veil Installer\n'
    printf '  https://veil.engrammic.ai\n'
    printf '\n'

    _tty_colors
    _check_deps

    _platform="$(_detect_platform)"
    ok "Platform: ${_platform}"

    _version="${VEIL_VERSION:-}"
    if [ -z "$_version" ]; then
        info "Fetching latest release..."
        _version="$(_latest_version)"
        if [ -z "$_version" ]; then
            die "Could not determine latest release. Set VEIL_VERSION=<tag> and retry."
        fi
    fi
    ok "Version:  ${_version}"

    _tmpdir="$(_mktmpdir)"

    _installer="$(_download_installer "$_platform" "$_version" "$_tmpdir")"

    # Pass version to installer (without 'v' prefix for semver compatibility)
    _ver_arg="$(printf '%s' "$_version" | sed 's/^v//')"
    set -- --install-version "$_ver_arg"
    if [ -n "${VEIL_INSTALL_DIR:-}" ]; then
        set -- "$@" --path "$VEIL_INSTALL_DIR"
    fi

    printf '\n'
    info "Running installer..."
    printf '\n'

    exec "$_installer" "$@"
}

main "$@"
