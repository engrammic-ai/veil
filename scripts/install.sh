#!/usr/bin/env bash
#
# Veil installer
# Usage: curl -sSL https://veil.sh/install | sh
#
# This script installs Veil (autonomic context for AI agents).
# It requires Node.js 20+ and npm.
#

set -euo pipefail

REPO="https://github.com/engrammic/veil"
MIN_NODE_VERSION=20

# Colors (disable if not a terminal)
if [ -t 1 ]; then
    RED='\033[0;31m'
    GREEN='\033[0;32m'
    YELLOW='\033[0;33m'
    BLUE='\033[0;34m'
    NC='\033[0m'
else
    RED=''
    GREEN=''
    YELLOW=''
    BLUE=''
    NC=''
fi

info() { echo -e "${BLUE}[info]${NC} $1"; }
success() { echo -e "${GREEN}[ok]${NC} $1"; }
warn() { echo -e "${YELLOW}[warn]${NC} $1"; }
error() { echo -e "${RED}[error]${NC} $1" >&2; exit 1; }

# Check Node.js
check_node() {
    if ! command -v node &> /dev/null; then
        error "Node.js not found. Install Node.js $MIN_NODE_VERSION+ from https://nodejs.org"
    fi

    local version
    version=$(node -v | sed 's/v//' | cut -d. -f1)
    if [ "$version" -lt "$MIN_NODE_VERSION" ]; then
        error "Node.js $MIN_NODE_VERSION+ required, found v$version"
    fi
    success "Node.js v$(node -v | sed 's/v//') detected"
}

# Check npm
check_npm() {
    if ! command -v npm &> /dev/null; then
        error "npm not found. Install npm (usually bundled with Node.js)"
    fi
    success "npm $(npm -v) detected"
}

# Install via npm
install_npm() {
    info "Installing Veil via npm..."

    # Check if already installed
    if command -v veil &> /dev/null; then
        warn "Veil already installed at $(which veil)"
        read -p "Reinstall? [y/N] " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            info "Skipping installation"
            return 0
        fi
    fi

    npm install -g @earendil-works/pi-coding-agent
    success "Veil installed!"
}

# Verify installation
verify() {
    if command -v veil &> /dev/null; then
        success "Veil ready: $(veil --version 2>/dev/null || echo 'installed')"
        echo
        info "Quick start:"
        echo "  cd your-project"
        echo "  veil"
        echo
        info "Documentation: $REPO"
    else
        warn "Installation completed but 'veil' not in PATH"
        info "Try: npm bin -g"
    fi
}

main() {
    echo
    echo "  Veil Installer"
    echo "  Autonomic context for AI agents"
    echo

    check_node
    check_npm
    install_npm
    verify
}

main "$@"
