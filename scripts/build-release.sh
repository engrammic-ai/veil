#!/usr/bin/env bash
set -euo pipefail

# Build release binaries and archives for all platforms.
# Run from repo root after `npm run build`.

PLATFORMS="darwin-arm64 darwin-x64 linux-x64 linux-arm64 windows-x64 windows-arm64"
BINARIES_DIR="packages/coding-agent/binaries"

echo "==> Building binaries for all platforms"
mkdir -p "$BINARIES_DIR"/{darwin-arm64,darwin-x64,linux-x64,linux-arm64,windows-x64,windows-arm64}

cd packages/coding-agent

for platform in darwin-arm64 darwin-x64 linux-x64 linux-arm64; do
  echo "Building for $platform..."
  bun build --compile --target=bun-$platform \
    ./dist/bun/cli.js ./src/utils/image-resize-worker.ts \
    --outfile binaries/$platform/veil
done

for platform in windows-x64 windows-arm64; do
  echo "Building for $platform..."
  bun build --compile --target=bun-$platform \
    ./dist/bun/cli.js ./src/utils/image-resize-worker.ts \
    --outfile binaries/$platform/veil.exe
done

echo "==> Bundling assets"
for platform in $PLATFORMS; do
  cp package.json binaries/$platform/
  cp README.md CHANGELOG.md binaries/$platform/
  cp ../../node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm binaries/$platform/
  mkdir -p binaries/$platform/theme
  cp dist/modes/interactive/theme/*.json binaries/$platform/theme/
  mkdir -p binaries/$platform/assets
  cp dist/modes/interactive/assets/* binaries/$platform/assets/
  cp -r dist/core/export-html binaries/$platform/
  cp -r docs binaries/$platform/
  cp -r examples binaries/$platform/
done

echo "==> Bundling clipboard bindings"
for platform in $PLATFORMS; do
  case "$platform" in
    darwin-arm64) clipboard="clipboard-darwin-arm64" ;;
    darwin-x64) clipboard="clipboard-darwin-x64" ;;
    linux-x64) clipboard="clipboard-linux-x64-gnu" ;;
    linux-arm64) clipboard="clipboard-linux-arm64-gnu" ;;
    windows-x64) clipboard="clipboard-win32-x64-msvc" ;;
    windows-arm64) clipboard="clipboard-win32-arm64-msvc" ;;
  esac
  mkdir -p binaries/$platform/node_modules/@mariozechner
  cp -r ../../node_modules/@mariozechner/clipboard binaries/$platform/node_modules/@mariozechner/
  cp -r ../../node_modules/@mariozechner/$clipboard binaries/$platform/node_modules/@mariozechner/
done

echo "==> Bundling native helpers"
for platform in darwin-arm64 darwin-x64; do
  mkdir -p binaries/$platform/native/darwin/prebuilds/$platform
  cp ../tui/native/darwin/prebuilds/$platform/darwin-modifiers.node binaries/$platform/native/darwin/prebuilds/$platform/
done
for platform in windows-x64 windows-arm64; do
  win32_arch=$(echo $platform | sed 's/windows/win32/')
  mkdir -p binaries/$platform/native/win32/prebuilds/$win32_arch
  cp ../tui/native/win32/prebuilds/$win32_arch/win32-console-mode.node binaries/$platform/native/win32/prebuilds/$win32_arch/
done

echo "==> Creating archives"
cd binaries
for platform in darwin-arm64 darwin-x64 linux-x64 linux-arm64; do
  mv $platform veil && tar -czf veil-$platform.tar.gz veil && mv veil $platform
done
for platform in windows-x64 windows-arm64; do
  (cd $platform && zip -r ../veil-$platform.zip .)
done

sha256sum veil-*.tar.gz veil-*.zip > checksums.sha256

echo "==> Done! Archives in $BINARIES_DIR:"
ls -la veil-*.tar.gz veil-*.zip checksums.sha256
