#!/usr/bin/env bash
set -euo pipefail

###############################################################################
# web.sh — Coin Smith: PSBT builder web UI and visualizer
###############################################################################

PORT="${PORT:-3000}"
export PORT

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "$SCRIPT_DIR/src/server.js"
