#!/usr/bin/env bash
set -euo pipefail

# One-click launcher for a dev Electron instance isolated from official app.
# Uses a separate config dir so .server.lock / workspaces / settings won't conflict.

CRAFT_DEBUG_TITLE=1

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Defaults (can override via env before running this script)
CRAFT_CONFIG_DIR="${CRAFT_CONFIG_DIR:-$HOME/.crystal-agent-dev}"
CRAFT_VITE_PORT="${CRAFT_VITE_PORT:-6173}"
CRAFT_APP_NAME="${CRAFT_APP_NAME:-Crystal Agents Dev}"
CRAFT_DEEPLINK_SCHEME="${CRAFT_DEEPLINK_SCHEME:-crystalagentsdev}"
CRAFT_APP_VARIANT_PATH="${CRAFT_APP_VARIANT_PATH:-$ROOT_DIR/apps/electron/resources/app-variant.dev.json}"
CRAFT_ELECTRON_USER_DATA_DIR="${CRAFT_ELECTRON_USER_DATA_DIR:-$CRAFT_CONFIG_DIR/electron}"

export CRAFT_CONFIG_DIR
export CRAFT_VITE_PORT
export CRAFT_APP_NAME
export CRAFT_DEEPLINK_SCHEME
export CRAFT_APP_VARIANT_PATH
export CRAFT_ELECTRON_USER_DATA_DIR
export CRAFT_DEBUG_TITLE

mkdir -p "$CRAFT_CONFIG_DIR" "$CRAFT_ELECTRON_USER_DATA_DIR"

echo "[dev-instance] ROOT_DIR=$ROOT_DIR"
echo "[dev-instance] CRAFT_CONFIG_DIR=$CRAFT_CONFIG_DIR"
echo "[dev-instance] CRAFT_VITE_PORT=$CRAFT_VITE_PORT"
echo "[dev-instance] CRAFT_APP_NAME=$CRAFT_APP_NAME"
echo "[dev-instance] CRAFT_DEEPLINK_SCHEME=$CRAFT_DEEPLINK_SCHEME"
echo "[dev-instance] CRAFT_APP_VARIANT_PATH=$CRAFT_APP_VARIANT_PATH"
echo "[dev-instance] CRAFT_ELECTRON_USER_DATA_DIR=$CRAFT_ELECTRON_USER_DATA_DIR"
echo "[dev-instance] CRAFT_DEBUG_TITLE=$CRAFT_DEBUG_TITLE"

cd "$ROOT_DIR"
exec bun run electron:dev
