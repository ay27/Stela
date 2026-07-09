#!/usr/bin/env bash
# afterFileEdit: if a sensitive path was edited, mark this workspace for a stop-time docs gate.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MARKER="$ROOT/.cursor/.docs-gate-pending"

input=$(cat)
file_path=$(printf '%s' "$input" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("file_path",""))' 2>/dev/null || true)

case "$file_path" in
  */electron/shared/*|\
  */electron/services/connectors/*|\
  */electron/services/result-store.ts|\
  */electron/services/history-journal.ts|\
  */electron/services/git/*|\
  */electron/main/vault-context.ts|\
  */electron/main/handlers.ts|\
  */electron/main/ipc-router.ts|\
  */electron/preload/*|\
  */src/contracts/*|\
  */src/core/*|\
  */plugin-sdk/*|\
  */AGENTS.md|\
  */docs/ARCHITECTURE.md|\
  */docs/ABSTRACTIONS.md|\
  */docs/adr/*)
    {
      echo "file_path=$file_path"
      echo "ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    } >>"$MARKER"
    ;;
esac

echo '{}'
