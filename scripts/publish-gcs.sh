#!/usr/bin/env bash
set -euo pipefail

# Upload release artifacts to GCS and update releases.json manifest.
# Expects: VEIL_VERSION env var, archives in packages/coding-agent/binaries/

BUCKET="gs://veil-releases"
VERSION="${VEIL_VERSION:?VEIL_VERSION required}"
BINARIES_DIR="packages/coding-agent/binaries"
CHANNEL="${VEIL_CHANNEL:-stable}"

echo "==> Uploading v$VERSION to GCS"

# Upload archives
gcloud storage cp "$BINARIES_DIR"/veil-*.tar.gz "$BINARIES_DIR"/veil-*.zip "$BUCKET/v$VERSION/"
gcloud storage cp "$BINARIES_DIR/checksums.sha256" "$BUCKET/v$VERSION/"

echo "==> Updating releases.json"

# Fetch existing manifest or create empty one
MANIFEST=$(mktemp)
if gcloud storage cat "$BUCKET/releases.json" > "$MANIFEST" 2>/dev/null; then
  echo "Found existing manifest"
else
  echo '{"releases":[]}' > "$MANIFEST"
fi

# Build asset URLs
BASE_URL="https://storage.googleapis.com/veil-releases/v$VERSION"
ASSETS=$(cat <<EOF
{
  "linux-x64": "$BASE_URL/veil-linux-x64.tar.gz",
  "linux-arm64": "$BASE_URL/veil-linux-arm64.tar.gz",
  "darwin-x64": "$BASE_URL/veil-darwin-x64.tar.gz",
  "darwin-arm64": "$BASE_URL/veil-darwin-arm64.tar.gz",
  "windows-x64": "$BASE_URL/veil-windows-x64.zip",
  "windows-arm64": "$BASE_URL/veil-windows-arm64.zip"
}
EOF
)

# Add new release to manifest (prepend so latest is first)
NEW_RELEASE=$(cat <<EOF
{
  "version": "$VERSION",
  "channel": "$CHANNEL",
  "date": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "assets": $ASSETS
}
EOF
)

# Use jq to prepend new release, removing any existing entry for this version
UPDATED=$(jq --argjson new "$NEW_RELEASE" '
  .releases = [$new] + [.releases[] | select(.version != $new.version)]
' "$MANIFEST")

echo "$UPDATED" > "$MANIFEST"

# Upload updated manifest
gcloud storage cp "$MANIFEST" "$BUCKET/releases.json"

rm "$MANIFEST"
echo "==> Done: v$VERSION published to $BUCKET"
