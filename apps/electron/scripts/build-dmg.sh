#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ELECTRON_DIR="$(dirname "$SCRIPT_DIR")"
ROOT_DIR="$(dirname "$(dirname "$ELECTRON_DIR")")"

# Helper function to check required file/directory exists
require_path() {
    local path="$1"
    local description="$2"
    local hint="$3"

    if [ ! -e "$path" ]; then
        echo "ERROR: $description not found at $path"
        [ -n "$hint" ] && echo "$hint"
        exit 1
    fi
}

# Sync secrets from 1Password if CLI is available
if command -v op &> /dev/null; then
    echo "1Password CLI detected, syncing secrets..."
    cd "$ROOT_DIR"
    if bun run sync-secrets 2>/dev/null; then
        echo "Secrets synced from 1Password"
    else
        echo "Warning: Failed to sync secrets from 1Password (continuing with existing .env if present)"
    fi
fi

# Load environment variables from .env
if [ -f "$ROOT_DIR/.env" ]; then
    set -a
    source "$ROOT_DIR/.env"
    set +a
fi

# Parse arguments
ARCH="arm64"
UPLOAD=false
UPLOAD_LATEST=false
UPLOAD_SCRIPT=false
SIGN=true
PROXY_URL="${CRAFT_BUILD_PROXY_URL:-}"

show_help() {
    cat << EOF
Usage: build-dmg.sh [arm64|x64] [--upload] [--latest] [--script] [--no-sign] [--proxy-url <url>]

Arguments:
  arm64|x64    Target architecture (default: arm64)
  --upload     Upload DMG to S3 after building
  --latest     Also update electron/latest (requires --upload)
  --script     Also upload install-app.sh (requires --upload)
  --no-sign    Skip code signing (for local test builds)
  --proxy-url  Use HTTP/HTTPS proxy for downloads (default: direct)

Environment variables (from .env or environment):
  APPLE_SIGNING_IDENTITY    - Code signing identity
  APPLE_ID                  - Apple ID for notarization
  APPLE_TEAM_ID             - Apple Team ID
  APPLE_APP_SPECIFIC_PASSWORD - App-specific password
  S3_VERSIONS_BUCKET_*      - S3 credentials (for --upload)
  CRAFT_BUILD_PROXY_URL     - Default proxy URL for build/downloads
EOF
    exit 0
}

while [[ $# -gt 0 ]]; do
    case $1 in
        arm64|x64)     ARCH="$1"; shift ;;
        --upload)      UPLOAD=true; shift ;;
        --latest)      UPLOAD_LATEST=true; shift ;;
        --script)      UPLOAD_SCRIPT=true; shift ;;
        --no-sign)     SIGN=false; shift ;;
        --proxy-url)
            if [ -z "${2:-}" ]; then
                echo "ERROR: --proxy-url requires a value"
                exit 1
            fi
            PROXY_URL="$2"
            shift 2
            ;;
        -h|--help)     show_help ;;
        *)
            echo "Unknown option: $1"
            echo "Run with --help for usage"
            exit 1
            ;;
    esac
done

# Configuration
BUN_VERSION="bun-v1.3.9"  # Pinned version for reproducible builds
BUN_VENDOR_DIR="$ELECTRON_DIR/vendor/bun"
BUN_VENDOR_BIN="$BUN_VENDOR_DIR/bun"
BUN_VENDOR_VERSION_FILE="$BUN_VENDOR_DIR/.version"

if [ -n "$PROXY_URL" ]; then
    export HTTP_PROXY="$PROXY_URL"
    export HTTPS_PROXY="$PROXY_URL"
    export ALL_PROXY="$PROXY_URL"
    export http_proxy="$PROXY_URL"
    export https_proxy="$PROXY_URL"
    export all_proxy="$PROXY_URL"
    echo "Using build proxy: $PROXY_URL"
fi

echo "=== Building Craft Agents DMG (${ARCH}) using electron-builder ==="
if [ "$UPLOAD" = true ]; then
    echo "Will upload to S3 after build"
fi

# 1. Clean previous build artifacts
echo "Cleaning previous builds..."
# Keep vendor/bun cache to avoid re-downloading identical Bun version every build.
rm -rf "$ELECTRON_DIR/node_modules/@anthropic-ai"
rm -rf "$ELECTRON_DIR/packages"
rm -rf "$ELECTRON_DIR/release"

# 2. Install dependencies
echo "Installing dependencies..."
cd "$ROOT_DIR"
bun install

# 3. Build and stage subprocess servers (session-mcp-server / pi-agent-server)
echo "Building and staging subprocess servers..."
cd "$ROOT_DIR"
bun run scripts/build/stage-subprocess-servers.ts --platform darwin --arch "$ARCH"

# 4. Ensure pinned Bun binary (with local cache)
BUN_DOWNLOAD="bun-darwin-$([ "$ARCH" = "arm64" ] && echo "aarch64" || echo "x64")"
EXPECTED_BUN_MARKER="${BUN_VERSION}:${BUN_DOWNLOAD}"

if [ -x "$BUN_VENDOR_BIN" ] && [ -f "$BUN_VENDOR_VERSION_FILE" ] && [ "$(cat "$BUN_VENDOR_VERSION_FILE")" = "$EXPECTED_BUN_MARKER" ]; then
    echo "Using cached Bun ${EXPECTED_BUN_MARKER}"
else
    echo "Downloading Bun ${BUN_VERSION} for darwin-${ARCH}..."
    mkdir -p "$BUN_VENDOR_DIR"

    # Create temp directory to avoid race conditions
    TEMP_DIR=$(mktemp -d)
    trap "rm -rf $TEMP_DIR" EXIT

    # Download binary and checksums
    CURL_PROXY_ARGS=()
    if [ -n "$PROXY_URL" ]; then
        CURL_PROXY_ARGS=(--proxy "$PROXY_URL")
    fi

    curl -fSL "${CURL_PROXY_ARGS[@]}" "https://github.com/oven-sh/bun/releases/download/${BUN_VERSION}/${BUN_DOWNLOAD}.zip" -o "$TEMP_DIR/${BUN_DOWNLOAD}.zip"
    curl -fSL "${CURL_PROXY_ARGS[@]}" "https://github.com/oven-sh/bun/releases/download/${BUN_VERSION}/SHASUMS256.txt" -o "$TEMP_DIR/SHASUMS256.txt"

    # Verify checksum
    echo "Verifying checksum..."
    cd "$TEMP_DIR"
    grep "${BUN_DOWNLOAD}.zip" SHASUMS256.txt | shasum -a 256 -c -
    cd - > /dev/null

    # Extract and install
    unzip -o "$TEMP_DIR/${BUN_DOWNLOAD}.zip" -d "$TEMP_DIR"
    cp "$TEMP_DIR/${BUN_DOWNLOAD}/bun" "$BUN_VENDOR_BIN"
    chmod +x "$BUN_VENDOR_BIN"
    printf "%s" "$EXPECTED_BUN_MARKER" > "$BUN_VENDOR_VERSION_FILE"
fi

# 5. Copy SDK from root node_modules (monorepo hoisting)
# Note: The SDK is hoisted to root node_modules by the package manager.
# We copy it here because electron-builder only sees apps/electron/.
SDK_SOURCE="$ROOT_DIR/node_modules/@anthropic-ai/claude-agent-sdk"
require_path "$SDK_SOURCE" "SDK" "Run 'bun install' from the repository root first."
echo "Copying SDK..."
mkdir -p "$ELECTRON_DIR/node_modules/@anthropic-ai"
cp -r "$SDK_SOURCE" "$ELECTRON_DIR/node_modules/@anthropic-ai/"

# 6. Copy interceptor
INTERCEPTOR_SOURCE="$ROOT_DIR/packages/shared/src/unified-network-interceptor.ts"
require_path "$INTERCEPTOR_SOURCE" "Interceptor" "Ensure packages/shared/src/unified-network-interceptor.ts exists."
echo "Copying interceptor..."
mkdir -p "$ELECTRON_DIR/packages/shared/src"
cp "$INTERCEPTOR_SOURCE" "$ELECTRON_DIR/packages/shared/src/"
# Also copy dependencies imported by the interceptor at runtime
for dep in interceptor-common.ts feature-flags.ts interceptor-request-utils.ts; do
  if [ -f "$ROOT_DIR/packages/shared/src/$dep" ]; then
    cp "$ROOT_DIR/packages/shared/src/$dep" "$ELECTRON_DIR/packages/shared/src/"
  fi
done

# 7. Build Electron app
echo "Building Electron app..."
cd "$ROOT_DIR"
bun run electron:build

# 8. Package with electron-builder
echo "Packaging app with electron-builder..."
cd "$ROOT_DIR"
VARIANT_BUILDER_CONFIG=$(bun run apps/electron/scripts/build-variant-config.ts)
cd "$ELECTRON_DIR"

# Set up environment for electron-builder
if [ "$SIGN" = true ]; then
    export CSC_IDENTITY_AUTO_DISCOVERY=true
else
    export CSC_IDENTITY_AUTO_DISCOVERY=false
    unset CSC_NAME
    echo "Code signing disabled (--no-sign)"
fi

# Build electron-builder arguments
BUILDER_ARGS="--mac --${ARCH}"

# Add code signing if identity is available
if [ "$SIGN" = true ] && [ -n "$APPLE_SIGNING_IDENTITY" ]; then
    # Strip "Developer ID Application: " prefix if present (electron-builder adds it automatically)
    CSC_NAME_CLEAN="${APPLE_SIGNING_IDENTITY#Developer ID Application: }"
    echo "Using signing identity: $CSC_NAME_CLEAN"
    export CSC_NAME="$CSC_NAME_CLEAN"
fi

# Add notarization if all credentials are available
if [ "$SIGN" = true ] && [ -n "$APPLE_ID" ] && [ -n "$APPLE_TEAM_ID" ] && [ -n "$APPLE_APP_SPECIFIC_PASSWORD" ]; then
    echo "Notarization enabled"
    export APPLE_ID="$APPLE_ID"
    export APPLE_TEAM_ID="$APPLE_TEAM_ID"
    export APPLE_APP_SPECIFIC_PASSWORD="$APPLE_APP_SPECIFIC_PASSWORD"

    # Enable notarization in electron-builder by setting env vars
    # The electron-builder.yml has notarize section commented out,
    # but we can enable it via environment
    export NOTARIZE=true
fi

# Run electron-builder
npx electron-builder --config "$VARIANT_BUILDER_CONFIG" $BUILDER_ARGS

# 9. Verify the DMG was built
DMG_PATH=$(find "$ELECTRON_DIR/release" -maxdepth 1 -name "*.dmg" -type f | head -n 1)

if [ -z "$DMG_PATH" ] || [ ! -f "$DMG_PATH" ]; then
    echo "ERROR: No DMG artifact found in $ELECTRON_DIR/release"
    echo "Contents of release directory:"
    ls -la "$ELECTRON_DIR/release/"
    exit 1
fi

DMG_NAME=$(basename "$DMG_PATH")

echo ""
echo "=== Build Complete ==="
echo "DMG: $DMG_PATH"
echo "Size: $(du -h "$DMG_PATH" | cut -f1)"

# 10. Create manifest.json for upload script
# Read version from package.json
ELECTRON_VERSION=$(cat "$ELECTRON_DIR/package.json" | grep '"version"' | head -1 | sed 's/.*"version": *"\([^"]*\)".*/\1/')
echo "Creating manifest.json (version: $ELECTRON_VERSION)..."
mkdir -p "$ROOT_DIR/.build/upload"
echo "{\"version\": \"$ELECTRON_VERSION\"}" > "$ROOT_DIR/.build/upload/manifest.json"

# 10. Upload to S3 (if --upload flag is set)
if [ "$UPLOAD" = true ]; then
    echo ""
    echo "=== Uploading to S3 ==="

    # Check for S3 credentials
    if [ -z "$S3_VERSIONS_BUCKET_ENDPOINT" ] || [ -z "$S3_VERSIONS_BUCKET_ACCESS_KEY_ID" ] || [ -z "$S3_VERSIONS_BUCKET_SECRET_ACCESS_KEY" ]; then
        cat << EOF
ERROR: Missing S3 credentials. Set these environment variables:
  S3_VERSIONS_BUCKET_ENDPOINT
  S3_VERSIONS_BUCKET_ACCESS_KEY_ID
  S3_VERSIONS_BUCKET_SECRET_ACCESS_KEY

You can add them to .env or export them directly.
EOF
        exit 1
    fi

    # Build upload flags
    UPLOAD_FLAGS="--electron"
    [ "$UPLOAD_LATEST" = true ] && UPLOAD_FLAGS="$UPLOAD_FLAGS --latest"
    [ "$UPLOAD_SCRIPT" = true ] && UPLOAD_FLAGS="$UPLOAD_FLAGS --script"

    cd "$ROOT_DIR"
    bun run scripts/upload.ts $UPLOAD_FLAGS

    echo ""
    echo "=== Upload Complete ==="
fi
