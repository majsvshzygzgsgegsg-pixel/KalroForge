#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PORT="${KAIROFORGE_PORT:-3080}"

echo "Starting KairoForge at http://127.0.0.1:${PORT}"
echo "Tip: set KAIROFORGE_PORT=3090 to use a different port."

exec node --import tsx/esm apps/cli/src/bin.ts web --port "$PORT" "$@"
