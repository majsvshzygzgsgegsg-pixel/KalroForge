#!/bin/bash
# Keep the KairoForge vault current.
#
# Runs one sync immediately and then every 15 minutes. Designed to be started
# once and left running: every conversation the user has through the harness is
# captured into the vault automatically, so memory accumulates without any
# manual step.
#
# Install as a background job:
#     nohup bash scripts/vault_autosync.sh >/dev/null 2>&1 &
#
# Or as a launchd agent for a permanent install (see docs/VAULT.md).

set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INTERVAL="${VAULT_SYNC_INTERVAL:-900}"
LOG="$DIR/.kairoforge/vault-autosync.log"

mkdir -p "$DIR/.kairoforge"

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] vault autosync starting (interval ${INTERVAL}s)" >> "$LOG"

while true; do
  if python3 "$DIR/scripts/vault_sync.py" sync >> "$LOG" 2>&1; then
    :
  else
    # A failed sync is logged and retried next interval; it never exits the
    # loop, because a single transient failure should not stop memory capture.
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] sync failed; retrying next interval" >> "$LOG"
  fi
  sleep "$INTERVAL"
done
