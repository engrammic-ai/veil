#!/usr/bin/env bash
#
# Veil installer
# Usage: curl -sSL https://veil.engrammic.ai/install | sh
#
# Downloads pre-built binary for your platform.
#

set -euo pipefail

REPO="engrammic-ai/veil"
INSTALL_DIR="${VEIL_INSTALL_DIR:-$HOME/.veil}"
BIN_DIR="${VEIL_BIN_DIR:-$HOME/.local/bin}"

# Colors
if [ -t 1 ]; then
    RED='\033[0;31m'
    GREEN='\033[0;32m'
    YELLOW='\033[0;33m'
    BLUE='\033[0;34m'
    NC='\033[0m'
else
    RED='' GREEN='' YELLOW='' BLUE='' NC=''
fi

info() { echo -e "${BLUE}info${NC} $1"; }
ok() { echo -e "${GREEN}ok${NC} $1"; }
warn() { echo -e "${YELLOW}warn${NC} $1"; }
err() { echo -e "${RED}error${NC} $1" >&2; exit 1; }

detect_platform() {
    local os arch

    case "$(uname -s)" in
        Linux*)  os="linux" ;;
        Darwin*) os="darwin" ;;
        MINGW*|MSYS*|CYGWIN*) os="windows" ;;
        *) err "Unsupported OS: $(uname -s)" ;;
    esac

    case "$(uname -m)" in
        x86_64|amd64) arch="x64" ;;
        arm64|aarch64) arch="arm64" ;;
        *) err "Unsupported architecture: $(uname -m)" ;;
    esac

    echo "${os}-${arch}"
}

get_latest_version() {
    curl -sSL "https://api.github.com/repos/${REPO}/releases/latest" \
        | grep '"tag_name"' \
        | sed -E 's/.*"([^"]+)".*/\1/'
}

download_binary() {
    local platform="$1"
    local version="$2"
    local url="https://github.com/${REPO}/releases/download/${version}/veil-${platform}"

    if [ "$platform" = "windows-x64" ]; then
        url="${url}.exe"
    fi

    info "Downloading veil ${version} for ${platform}..."

    mkdir -p "$INSTALL_DIR"

    if command -v curl &> /dev/null; then
        curl -sSL "$url" -o "$INSTALL_DIR/veil"
    elif command -v wget &> /dev/null; then
        wget -q "$url" -O "$INSTALL_DIR/veil"
    else
        err "curl or wget required"
    fi

    chmod +x "$INSTALL_DIR/veil"
    ok "Downloaded to $INSTALL_DIR/veil"
}

setup_path() {
    mkdir -p "$BIN_DIR"
    ln -sf "$INSTALL_DIR/veil" "$BIN_DIR/veil"

    # Check if BIN_DIR is in PATH
    case ":$PATH:" in
        *":$BIN_DIR:"*) ;;
        *)
            warn "$BIN_DIR is not in PATH"
            echo
            echo "Add to your shell config:"
            echo "  export PATH=\"\$PATH:$BIN_DIR\""
            ;;
    esac
}

main() {
    echo
    echo "  Veil Installer"
    echo "  Autonomic context for AI agents"
    echo

    local platform version

    platform=$(detect_platform)
    ok "Platform: $platform"

    version=$(get_latest_version)
    if [ -z "$version" ]; then
        err "Could not fetch latest version"
    fi
    ok "Version: $version"

    download_binary "$platform" "$version"
    setup_path

    echo
    ok "Veil installed!"
    echo
    info "Run: veil"
    echo
}

main "$@"
