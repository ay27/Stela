---
type: ADR
id: "0003"
title: "SQLite as disposable run-result cache"
status: active
date: 2026-03-20
---

## Context

RunSQL blocks need fast paginated result display, block-level history browsing, and diff comparison. Scanning JSONL on every page turn is too slow. But SQLite files are binary, merge-conflict-prone, and opaque to external tools.

## Decision

**`{vault}/.stela.sqlite` is a disposable query cache**, never an authority. It stores `runs`, `result_schemas`, and `result_rows` for fast `queryPage` / `listRunsByBlockId`. It is gitignored and rebuildable from JSONL via `history-journal` incremental import. `journal_cursors` tracks per-source byte offsets.

## Options considered

- **SQLite as authority**: simplest query path, but Git conflicts on binary files, no portable export. Rejected.
- **In-memory only**: no disk footprint, but lost on restart; large vaults exceed RAM. Rejected.
- **SQLite cache + JSONL authority** (chosen): fast reads, safe Git sync, rebuildable.

## Consequences

- Deleting `.stela.sqlite` is safe — next vault open re-imports from JSONL
- Missing runs (import lag) trigger on-demand `importRun` from JSONL
- better-sqlite3 runs synchronously in main process — large imports must not block UI (background import on vault open)
- WAL mode allows concurrent read during import
- Triggers re-evaluation if: vault scale requires server-side query engine or columnar store
