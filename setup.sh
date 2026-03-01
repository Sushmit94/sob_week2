#!/usr/bin/env bash
set -euo pipefail

###############################################################################
# setup.sh — Install dependencies for Coin Smith
###############################################################################

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

npm install --production 2>&1

echo "Setup complete"
