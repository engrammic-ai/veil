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

echo "==> Bundling SQLite native modules"
BETTER_SQLITE_VER=$(node -p "require('../../packages/veil-memory/package.json').dependencies['better-sqlite3']")
for platform in $PLATFORMS; do
  mkdir -p binaries/$platform/native/sqlite
  mkdir -p binaries/$platform/node_modules

  # Copy better-sqlite3 JS package (native loader sets BETTER_SQLITE3_BINDING)
  cp -r ../../node_modules/better-sqlite3 binaries/$platform/node_modules/
  rm -rf binaries/$platform/node_modules/better-sqlite3/prebuilds

  # Map platform to better-sqlite3 naming
  case "$platform" in
    darwin-arm64) bs3_plat="darwin-arm64" ;;
    darwin-x64) bs3_plat="darwin-x64" ;;
    linux-x64) bs3_plat="linux-x64" ;;
    linux-arm64) bs3_plat="linux-arm64" ;;
    windows-x64) bs3_plat="win32-x64" ;;
    windows-arm64) bs3_plat="win32-arm64" ;;
  esac

  # Download better-sqlite3 prebuild (node-v127 = Node 22+)
  echo "  Downloading better-sqlite3 prebuild for $platform..."
  curl -sL "https://github.com/WiseLibs/better-sqlite3/releases/download/v${BETTER_SQLITE_VER}/better-sqlite3-v${BETTER_SQLITE_VER}-node-v127-${bs3_plat}.tar.gz" | tar -xz -C binaries/$platform/native/sqlite/

  # Copy sqlite-vec extension and JS wrapper
  case "$platform" in
    darwin-arm64) vec_pkg="sqlite-vec-darwin-arm64" ;;
    darwin-x64) vec_pkg="sqlite-vec-darwin-x64" ;;
    linux-x64) vec_pkg="sqlite-vec-linux-x64" ;;
    linux-arm64) vec_pkg="sqlite-vec-linux-arm64" ;;
    windows-x64) vec_pkg="sqlite-vec-windows-x64" ;;
    windows-arm64) vec_pkg="sqlite-vec-windows-x64" ;; # fallback
  esac
  cp -r ../../node_modules/sqlite-vec binaries/$platform/node_modules/
  if [ -d "../../node_modules/$vec_pkg" ]; then
    cp ../../node_modules/$vec_pkg/*.so binaries/$platform/native/sqlite/ 2>/dev/null || \
    cp ../../node_modules/$vec_pkg/*.dylib binaries/$platform/native/sqlite/ 2>/dev/null || \
    cp ../../node_modules/$vec_pkg/*.dll binaries/$platform/native/sqlite/ 2>/dev/null || true
  fi
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
