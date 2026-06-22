#!/usr/bin/env bash
set -euo pipefail

# Release installer binaries after veil release is tagged.
# Run from repo root after `node scripts/release.mjs` pushes the tag.
#
# Usage: ./scripts/release-installer.sh [version]
#   version: optional, defaults to latest git tag

cd "$(dirname "$0")/.."

VERSION="${1:-$(git describe --tags --abbrev=0 2>/dev/null)}"
if [[ -z "$VERSION" ]]; then
    echo "error: no version specified and no git tags found"
    exit 1
fi

# Strip 'v' prefix for comparisons
VERSION_NUM="${VERSION#v}"
echo "==> Releasing installer for $VERSION"

# 1. Build installer binaries
echo "==> Building installer binaries..."
cd installer
just release
cd ..

DIST="installer/dist"

# 2. Upload to GCS
echo "==> Uploading to GCS..."
gcloud storage cp "$DIST/veil-installer-"* "gs://veil-releases/$VERSION/"

# 3. Update releases.json
echo "==> Updating releases.json..."
MANIFEST=$(mktemp)
curl -s "https://storage.googleapis.com/veil-releases/releases.json?$(date +%s)" > "$MANIFEST"

# Check if version already in manifest
if jq -e ".releases[] | select(.version == \"$VERSION_NUM\")" "$MANIFEST" > /dev/null 2>&1; then
    echo "  Version $VERSION_NUM already in releases, updating installer only..."
    jq --arg v "$VERSION_NUM" --arg ver "$VERSION" '
      .installer = {
        "version": $v,
        "assets": {
          "linux-x64": ("https://storage.googleapis.com/veil-releases/" + $ver + "/veil-installer-linux-x64"),
          "linux-arm64": ("https://storage.googleapis.com/veil-releases/" + $ver + "/veil-installer-linux-arm64"),
          "darwin-x64": ("https://storage.googleapis.com/veil-releases/" + $ver + "/veil-installer-darwin-x64"),
          "darwin-arm64": ("https://storage.googleapis.com/veil-releases/" + $ver + "/veil-installer-darwin-arm64"),
          "windows-x64": ("https://storage.googleapis.com/veil-releases/" + $ver + "/veil-installer-windows-x64.exe")
        }
      }
    ' "$MANIFEST" > "${MANIFEST}.new"
else
    echo "  Adding $VERSION_NUM to releases..."
    DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    jq --arg v "$VERSION_NUM" --arg ver "$VERSION" --arg date "$DATE" '
      .releases = [{
        "version": $v,
        "channel": "stable",
        "date": $date,
        "assets": {
          "linux-x64": ("https://storage.googleapis.com/veil-releases/" + $ver + "/veil-linux-x64.tar.gz"),
          "linux-arm64": ("https://storage.googleapis.com/veil-releases/" + $ver + "/veil-linux-arm64.tar.gz"),
          "darwin-x64": ("https://storage.googleapis.com/veil-releases/" + $ver + "/veil-darwin-x64.tar.gz"),
          "darwin-arm64": ("https://storage.googleapis.com/veil-releases/" + $ver + "/veil-darwin-arm64.tar.gz"),
          "windows-x64": ("https://storage.googleapis.com/veil-releases/" + $ver + "/veil-windows-x64.zip"),
          "windows-arm64": ("https://storage.googleapis.com/veil-releases/" + $ver + "/veil-windows-arm64.zip")
        }
      }] + .releases |
      .installer = {
        "version": $v,
        "assets": {
          "linux-x64": ("https://storage.googleapis.com/veil-releases/" + $ver + "/veil-installer-linux-x64"),
          "linux-arm64": ("https://storage.googleapis.com/veil-releases/" + $ver + "/veil-installer-linux-arm64"),
          "darwin-x64": ("https://storage.googleapis.com/veil-releases/" + $ver + "/veil-installer-darwin-x64"),
          "darwin-arm64": ("https://storage.googleapis.com/veil-releases/" + $ver + "/veil-installer-darwin-arm64"),
          "windows-x64": ("https://storage.googleapis.com/veil-releases/" + $ver + "/veil-installer-windows-x64.exe")
        }
      }
    ' "$MANIFEST" > "${MANIFEST}.new"
fi

mv "${MANIFEST}.new" "$MANIFEST"
gcloud storage cp "$MANIFEST" gs://veil-releases/releases.json
gcloud storage objects update gs://veil-releases/releases.json --cache-control="public, max-age=60"
rm "$MANIFEST"

# 4. Upload to GitHub releases
echo "==> Uploading to GitHub releases..."
gh release upload "$VERSION" \
    "$DIST/veil-installer-linux-x64" \
    "$DIST/veil-installer-linux-arm64" \
    "$DIST/veil-installer-darwin-x64" \
    "$DIST/veil-installer-darwin-arm64" \
    "$DIST/veil-installer-windows-x64.exe" \
    "$DIST/checksums.sha256" \
    --clobber

echo "==> Done! Installer $VERSION released."
