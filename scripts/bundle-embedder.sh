#!/usr/bin/env bash
set -euo pipefail

# Bundle the veil-embedder server for release distribution.
# Creates platform-specific bundles with onnxruntime binaries.
#
# Output: packages/coding-agent/binaries/<platform>/embedder/
#   - server.js, index.js, etc (dist files)
#   - package.json
#   - node_modules/ (with platform-specific onnxruntime)

PLATFORMS="darwin-arm64 darwin-x64 linux-x64 linux-arm64 windows-x64 windows-arm64"
BINARIES_DIR="packages/coding-agent/binaries"
EMBEDDER_PKG="packages/veil-embedder"

# Map our platform names to onnxruntime paths
get_onnx_platform() {
  case "$1" in
    darwin-arm64) echo "darwin/arm64" ;;
    darwin-x64)   echo "darwin/x64" ;;
    linux-x64)    echo "linux/x64" ;;
    linux-arm64)  echo "linux/arm64" ;;
    windows-x64)  echo "win32/x64" ;;
    windows-arm64) echo "win32/arm64" ;;
  esac
}

echo "==> Bundling embedder server"

# Ensure embedder is built
if [ ! -f "$EMBEDDER_PKG/dist/server.js" ]; then
  echo "Error: Embedder not built. Run 'npm run build' first."
  exit 1
fi

for platform in $PLATFORMS; do
  echo "Bundling embedder for $platform..."

  dest="$BINARIES_DIR/$platform/embedder"
  rm -rf "$dest"
  mkdir -p "$dest"

  # Copy dist files
  cp -r "$EMBEDDER_PKG/dist/"* "$dest/"
  cp "$EMBEDDER_PKG/package.json" "$dest/"

  # Create minimal node_modules structure
  mkdir -p "$dest/node_modules"

  # Copy @xenova/transformers (pure JS, same for all platforms)
  mkdir -p "$dest/node_modules/@xenova"
  cp -r node_modules/@xenova/transformers "$dest/node_modules/@xenova/"

  # Copy fastify and its dependencies
  for dep in fastify fast-json-stringify ajv ajv-formats fast-uri \
             json-schema-ref-resolver @fastify/ajv-compiler \
             @fastify/error @fastify/fast-json-stringify-compiler \
             @fastify/merge-json-schemas @fastify/proxy-addr @fastify/forwarded \
             abstract-logging avvio find-my-way light-my-request \
             pino pino-abstract-transport pino-std-serializers \
             process-warning rfdc secure-json-parse sonic-boom \
             on-exit-leak-free thread-stream quick-lru toad-cache \
             fast-redact fast-content-type-parse reusify; do
    if [ -d "node_modules/$dep" ]; then
      # Handle scoped packages
      if [[ "$dep" == @* ]]; then
        scope=$(dirname "$dep")
        mkdir -p "$dest/node_modules/$scope"
        cp -r "node_modules/$dep" "$dest/node_modules/$scope/"
      else
        cp -r "node_modules/$dep" "$dest/node_modules/"
      fi
    fi
  done

  # Copy onnxruntime packages
  mkdir -p "$dest/node_modules/onnxruntime-common"
  mkdir -p "$dest/node_modules/onnxruntime-node"

  cp -r node_modules/onnxruntime-common/* "$dest/node_modules/onnxruntime-common/"

  # Copy onnxruntime-node but only the platform-specific binary
  onnx_plat=$(get_onnx_platform "$platform")
  cp node_modules/onnxruntime-node/package.json "$dest/node_modules/onnxruntime-node/"
  cp -r node_modules/onnxruntime-node/dist "$dest/node_modules/onnxruntime-node/"
  cp -r node_modules/onnxruntime-node/lib "$dest/node_modules/onnxruntime-node/"

  # Only copy the relevant platform binary
  mkdir -p "$dest/node_modules/onnxruntime-node/bin/napi-v3/$onnx_plat"
  cp -r "node_modules/onnxruntime-node/bin/napi-v3/$onnx_plat/"* \
        "$dest/node_modules/onnxruntime-node/bin/napi-v3/$onnx_plat/"

  # Copy sharp if present (image processing fallback)
  if [ -d "node_modules/sharp" ]; then
    cp -r node_modules/sharp "$dest/node_modules/"
  fi

  echo "  -> $dest ($(du -sh "$dest" | cut -f1))"
done

echo "==> Embedder bundling complete"
