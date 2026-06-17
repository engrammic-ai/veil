#!/bin/sh
# Veil bootstrap installer
# Usage:
#   curl -fsSL https://install.veil.dev | sh
#   curl -fsSL https://install.veil.dev | VEIL_VERSION=1.2.3 sh
#   curl -fsSL https://install.veil.dev | VEIL_INSTALL_DIR=/usr/local/bin sh
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
# Output helpers (no echo -e; use printf for POSIX portability)
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

info()  { printf "${BLU}info${RST}  %s\n"  "$1"; }
ok()    { printf "${GRN}ok${RST}    %s\n"  "$1"; }
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
    _url="$1"
    _dest="$2"   # path, or "-" for stdout

    if _require_cmd curl; then
        if [ "$_dest" = "-" ]; then
            curl -fsSL "$_url"
        else
            curl -fsSL --retry 3 --retry-delay 2 -o "$_dest" "$_url"
        fi
    else
        if [ "$_dest" = "-" ]; then
            wget -qO- "$_url"
        else
            wget -q --tries=3 -O "$_dest" "$_url"
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

# Detect libc variant on Linux (glibc vs musl).
# Mirrors the logic in installer/internal/platform/detect.go.
_detect_libc() {
    # Check for musl loader paths first — no subprocess needed.
    for _musl_path in \
        /lib/ld-musl-x86_64.so.1 \
        /lib/ld-musl-aarch64.so.1 \
        /lib/ld-musl-armhf.so.1
    do
        if [ -e "$_musl_path" ]; then
            printf 'musl'
            return
        fi
    done

    # Fall back to ldd --version output inspection.
    if _require_cmd ldd; then
        _ldd_out="$(ldd --version 2>&1 || true)"
        case "$_ldd_out" in
            *musl*)                 printf 'musl';  return ;;
            *[Gg][Nn][Uu]*|*glibc*) printf 'glibc'; return ;;
        esac
    fi

    # Default: glibc is the most common libc on Linux.
    printf 'glibc'
}

# Returns a platform string matching the Go installer binary names:
#   linux-x64-glibc  linux-x64-musl  linux-arm64-glibc  linux-arm64-musl
#   darwin-x64       darwin-arm64
_detect_platform() {
    _os="$(_detect_os)"
    _arch="$(_detect_arch)"

    if [ "$_os" = "linux" ]; then
        _libc="$(_detect_libc)"
        printf '%s-%s-%s' "$_os" "$_arch" "$_libc"
    else
        printf '%s-%s' "$_os" "$_arch"
    fi
}

# ---------------------------------------------------------------------------
# Version resolution
# ---------------------------------------------------------------------------
_latest_version() {
    _json="$(_fetch "$API_URL" -)" || die "Could not reach GitHub API. Check your network connection."
    # Extract "tag_name" with POSIX tools only (no jq required).
    printf '%s' "$_json" \
        | grep '"tag_name"' \
        | head -n1 \
        | sed 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/'
}

# ---------------------------------------------------------------------------
# Checksum verification
# ---------------------------------------------------------------------------
_sha256sum_bin() {
    if _require_cmd sha256sum; then
        printf 'sha256sum'
    elif _require_cmd shasum; then
        printf 'shasum -a 256'
    else
        warn "No sha256sum or shasum found — skipping checksum verification."
        printf ''
    fi
}

_verify_checksum() {
    _file="$1"
    _expected_sum="$2"

    _sum_cmd="$(_sha256sum_bin)"
    if [ -z "$_sum_cmd" ]; then
        return 0  # already warned above
    fi

    # Compute actual checksum.
    _actual_sum="$(eval "$_sum_cmd" "$_file" | awk '{print $1}')"

    if [ "$_actual_sum" != "$_expected_sum" ]; then
        die "Checksum mismatch for $(basename "$_file").
  expected: $_expected_sum
  got:      $_actual_sum
Remove any cached downloads and try again, or report this at ${RELEASES_URL}."
    fi
}

# ---------------------------------------------------------------------------
# Download + verify installer binary
# ---------------------------------------------------------------------------
_download_installer() {
    _platform="$1"
    _version="$2"
    _tmpdir="$3"

    _base="veil-installer-${_platform}"
    _bin_url="${RELEASES_URL}/download/${_version}/${_base}"
    _sum_url="${_bin_url}.sha256"
    _dest="${_tmpdir}/${_base}"

    info "Downloading installer binary for ${_platform} (${_version})..."
    _fetch "$_bin_url" "$_dest" || die "Download failed. Check your network or try again later.
  URL: $_bin_url"
    ok "Download complete."

    # Fetch checksum file and verify.
    _sum_file="${_dest}.sha256"
    info "Fetching checksum..."
    if _fetch "$_sum_url" "$_sum_file" 2>/dev/null; then
        # The .sha256 file may contain just the hex digest or be in
        # '<digest>  <filename>' format — grab the first field.
        _expected="$(awk '{print $1}' "$_sum_file")"
        info "Verifying checksum..."
        _verify_checksum "$_dest" "$_expected"
        ok "Checksum verified."
    else
        warn "Checksum file not found at release — skipping verification."
    fi

    chmod +x "$_dest"
    printf '%s' "$_dest"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
    printf '\n'
    printf '  Veil Installer\n'
    printf '  https://veil.dev\n'
    printf '\n'

    _tty_colors
    _check_deps

    # Resolve platform.
    _platform="$(_detect_platform)"
    ok "Platform: ${_platform}"

    # Resolve version.
    _version="${VEIL_VERSION:-}"
    if [ -z "$_version" ]; then
        info "Fetching latest release version..."
        _version="$(_latest_version)"
        if [ -z "$_version" ]; then
            die "Could not determine latest release. Set VEIL_VERSION=<tag> and retry."
        fi
    fi
    ok "Version:  ${_version}"

    # Build temp dir.
    _tmpdir="$(_mktmpdir)"

    # Download and verify the installer binary.
    _installer="$(_download_installer "$_platform" "$_version" "$_tmpdir")"

    # Build argument list for the installer binary.
    set -- --version "$_version"
    if [ -n "${VEIL_INSTALL_DIR:-}" ]; then
        set -- "$@" --install-dir "$VEIL_INSTALL_DIR"
    fi

    printf '\n'
    info "Running installer..."
    printf '\n'

    # Hand off to the Go installer binary.
    exec "$_installer" "$@"
}

main "$@"
