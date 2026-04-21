#!/usr/bin/env bash
set -euo pipefail

# One-click launcher for a dev Electron instance isolated from official app.
# Uses a separate config dir so .server.lock / workspaces / settings won't conflict.

CRAFT_DEBUG_TITLE="${CRAFT_DEBUG_TITLE:-1}"
CRAFT_DEBUG_TOOL_TITLES="${CRAFT_DEBUG_TOOL_TITLES:-1}"
CRAFT_DEBUG_STREAMING_STEPS="${CRAFT_DEBUG_STREAMING_STEPS:-1}"
CRAFT_DEBUG_SUBMIT_PLAN="${CRAFT_DEBUG_SUBMIT_PLAN:-0}"
CRAFT_DEBUG_TOOL_ARGS="${CRAFT_DEBUG_TOOL_ARGS:-1}"

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Defaults (can override via env before running this script)
CRAFT_CONFIG_DIR="${CRAFT_CONFIG_DIR:-$HOME/.crystal-agent-dev}"
CRAFT_VITE_PORT="${CRAFT_VITE_PORT:-6173}"
CRAFT_APP_VARIANT_PATH="${CRAFT_APP_VARIANT_PATH:-$ROOT_DIR/apps/electron/resources/app-variant.dev.json}"
CRAFT_ELECTRON_USER_DATA_DIR="${CRAFT_ELECTRON_USER_DATA_DIR:-$CRAFT_CONFIG_DIR/electron}"

export CRAFT_CONFIG_DIR
export CRAFT_VITE_PORT
export CRAFT_APP_VARIANT_PATH
export CRAFT_ELECTRON_USER_DATA_DIR
export CRAFT_DEBUG_TITLE
export CRAFT_DEBUG_TOOL_TITLES
export CRAFT_DEBUG_STREAMING_STEPS
export CRAFT_DEBUG_SUBMIT_PLAN
export CRAFT_DEBUG_TOOL_ARGS

mkdir -p "$CRAFT_CONFIG_DIR" "$CRAFT_ELECTRON_USER_DATA_DIR"

echo "[dev-instance] ROOT_DIR=$ROOT_DIR"
echo "[dev-instance] CRAFT_CONFIG_DIR=$CRAFT_CONFIG_DIR"
echo "[dev-instance] CRAFT_VITE_PORT=$CRAFT_VITE_PORT"
echo "[dev-instance] CRAFT_APP_VARIANT_PATH=$CRAFT_APP_VARIANT_PATH"
echo "[dev-instance] CRAFT_ELECTRON_USER_DATA_DIR=$CRAFT_ELECTRON_USER_DATA_DIR"
echo "[dev-instance] CRAFT_DEBUG_TITLE=$CRAFT_DEBUG_TITLE"
echo "[dev-instance] CRAFT_DEBUG_TOOL_TITLES=$CRAFT_DEBUG_TOOL_TITLES"
echo "[dev-instance] CRAFT_DEBUG_STREAMING_STEPS=$CRAFT_DEBUG_STREAMING_STEPS"
echo "[dev-instance] CRAFT_DEBUG_SUBMIT_PLAN=$CRAFT_DEBUG_SUBMIT_PLAN"
echo "[dev-instance] CRAFT_DEBUG_TOOL_ARGS=$CRAFT_DEBUG_TOOL_ARGS"

cd "$ROOT_DIR"
exec bun run electron:dev
