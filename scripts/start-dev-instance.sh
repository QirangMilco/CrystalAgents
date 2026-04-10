#!/usr/bin/env bash
set -euo pipefail

# One-click launcher for a dev Electron instance isolated from official app.
# Uses a separate config dir so .server.lock / workspaces / settings won't conflict.

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Defaults (can override via env before running this script)
CRAFT_CONFIG_DIR="${CRAFT_CONFIG_DIR:-$HOME/.craft-agent-dev}"
CRAFT_VITE_PORT="${CRAFT_VITE_PORT:-6173}"
CRAFT_APP_NAME="${CRAFT_APP_NAME:-Crystal Agents Dev}"
CRAFT_DEEPLINK_SCHEME="${CRAFT_DEEPLINK_SCHEME:-crystalagentsdev}"

export CRAFT_CONFIG_DIR
export CRAFT_VITE_PORT
export CRAFT_APP_NAME
export CRAFT_DEEPLINK_SCHEME

mkdir -p "$CRAFT_CONFIG_DIR"

echo "[dev-instance] ROOT_DIR=$ROOT_DIR"
echo "[dev-instance] CRAFT_CONFIG_DIR=$CRAFT_CONFIG_DIR"
echo "[dev-instance] CRAFT_VITE_PORT=$CRAFT_VITE_PORT"
echo "[dev-instance] CRAFT_APP_NAME=$CRAFT_APP_NAME"
echo "[dev-instance] CRAFT_DEEPLINK_SCHEME=$CRAFT_DEEPLINK_SCHEME"

cd "$ROOT_DIR"
exec bun run electron:dev
