# Veil build recipes

# Build all packages
build:
    npm --prefix packages/tui run build
    npm --prefix packages/ai run build
    npm --prefix packages/agent run build
    npm --prefix packages/coding-agent run build

# Build binary for current platform
binary: build
    cd packages/coding-agent && bun build --compile \
        ./dist/bun/cli.js ./src/utils/image-resize-worker.ts \
        --outfile dist/veil

# Build binaries for all platforms
binary-all: build
    #!/usr/bin/env bash
    set -euo pipefail
    cd packages/coding-agent

    targets=(
        "bun-linux-x64:veil-linux-amd64"
        "bun-linux-arm64:veil-linux-arm64"
        "bun-darwin-x64:veil-darwin-amd64"
        "bun-darwin-arm64:veil-darwin-arm64"
        "bun-windows-x64:veil-windows-amd64.exe"
    )

    mkdir -p dist/release

    for entry in "${targets[@]}"; do
        target="${entry%%:*}"
        asset="${entry##*:}"
        echo "Building $asset..."
        bun build --compile --target="$target" \
            ./dist/bun/cli.js ./src/utils/image-resize-worker.ts \
            --outfile "dist/release/$asset"
    done

    echo "Done. Binaries in packages/coding-agent/dist/release/"

# Create a GitHub release (requires gh CLI)
release version: binary-all
    gh release create "v{{version}}" \
        --title "v{{version}}" \
        --generate-notes \
        packages/coding-agent/dist/release/*

# Create a pre-release
prerelease version: binary-all
    gh release create "v{{version}}" \
        --title "v{{version}}" \
        --generate-notes \
        --prerelease \
        packages/coding-agent/dist/release/*
