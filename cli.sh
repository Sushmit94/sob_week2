#!/usr/bin/env bash
set -euo pipefail

###############################################################################
# cli.sh — Coin Smith: PSBT transaction builder CLI
#
# Usage:
#   ./cli.sh <fixture.json>
#
# Writes JSON report to out/<fixture_name>.json
# Exit 0 on success, 1 on error.
###############################################################################

error_json() {
  local code="$1"
  local message="$2"
  printf '{"ok":false,"error":{"code":"%s","message":"%s"}}\n' "$code" "$message"
}

if [[ $# -lt 1 ]]; then
  error_json "INVALID_ARGS" "Usage: cli.sh <fixture.json>"
  echo "Error: No fixture file provided" >&2
  exit 1
fi

FIXTURE="$1"

if [[ ! -f "$FIXTURE" ]]; then
  error_json "FILE_NOT_FOUND" "Fixture file not found: $FIXTURE"
  echo "Error: Fixture file not found: $FIXTURE" >&2
  exit 1
fi

# Create output directory
mkdir -p out

# Derive output filename from fixture basename
FIXTURE_NAME="$(basename "$FIXTURE")"
OUTPUT_FILE="out/$FIXTURE_NAME"

# Run the PSBT builder
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
node "$SCRIPT_DIR/src/cli.js" "$FIXTURE" "$OUTPUT_FILE"
