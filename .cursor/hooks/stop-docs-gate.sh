#!/usr/bin/env bash
# stop: if sensitive files were edited, auto-follow-up once for ADR/docs check.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MARKER="$ROOT/.cursor/.docs-gate-pending"

input=$(cat)
status=$(printf '%s' "$input" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("status",""))' 2>/dev/null || true)
loop_count=$(printf '%s' "$input" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("loop_count",0))' 2>/dev/null || echo 0)

if [[ "$status" != "completed" ]]; then
  echo '{}'
  exit 0
fi

# Only one automatic follow-up per agent completion cycle.
if [[ "${loop_count}" != "0" ]]; then
  rm -f "$MARKER"
  echo '{}'
  exit 0
fi

if [[ ! -f "$MARKER" ]]; then
  echo '{}'
  exit 0
fi

# Clear before emitting follow-up so a second stop cannot re-trigger.
rm -f "$MARKER"

python3 - <<'PY'
import json

msg = """Docs/ADR gate: this session edited architecture-sensitive paths.

Before finishing, do all of the following (or explicitly justify skips):

1. Decide whether an ADR is required (new dependency, storage/sync, IPC/security, connector protocol, core abstraction, cross-cutting pattern). If yes, follow `.cursor/skills/create-adr/SKILL.md` and update `docs/adr/README.md`.
2. Update living docs if the design changed:
   - `docs/ARCHITECTURE.md` for process/storage/IPC/connector/Git/AI architecture
   - `docs/ABSTRACTIONS.md` for domain types/contracts/conventions
3. End your reply with:
   - `ADRs: <ids or none>`
   - `Docs: <files updated or none>`

Do not ask the user for permission — complete the gate now if anything is missing. If already done, reply with only the ADRs/Docs lines confirming that."""

print(json.dumps({"followup_message": msg}, ensure_ascii=False))
PY
