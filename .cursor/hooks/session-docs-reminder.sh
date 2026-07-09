#!/usr/bin/env bash
# sessionStart: inject docs/ADR reminder into the conversation context.
set -euo pipefail

cat >/dev/null

python3 - <<'PY'
import json

ctx = """# Stela docs gate (session start)

Before structural code changes:
1. Read relevant sections of `docs/ARCHITECTURE.md` and `docs/ABSTRACTIONS.md`
2. Check `docs/adr/` for constraints
3. If the change needs an ADR (dependency, storage/sync, IPC/security, connector protocol, core abstraction), decide first

After structural changes / before finishing:
- Create or supersede ADR via `.cursor/skills/create-adr/SKILL.md`
- Update ARCHITECTURE.md / ABSTRACTIONS.md when the living design changed
- End with `ADRs: …` and `Docs: …` (or `none`)

Sensitive paths that almost always need the docs gate:
`electron/shared/**`, `electron/services/connectors/**`, `result-store` / `history-journal` / `git/**`, `vault-context.ts`, `src/contracts/**`, `src/core/**`, `plugin-sdk/**`
"""

print(json.dumps({"additional_context": ctx}, ensure_ascii=False))
PY
