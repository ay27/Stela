---
type: ADR
id: "0006"
title: "RunSQL execution metadata embedded in Markdown via `<detail>`"
status: active
date: 2026-04-01
---

## Context

After SQL execution, users need to see when a query ran, how long it took, row count, and a preview row — without opening a separate history panel. External Markdown viewers (GitHub, Obsidian) should show meaningful execution traces. The editor must round-trip user edits without corrupting metadata.

## Decision

**Each executed `runsql` block is immediately followed by an HTML `<detail>` block** in the Markdown file. `<detail>` stores a human-readable summary and a `result-ref-id` pointing to the full result in SQLite/JSONL. The canonical parse/serialize implementation lives in a single shared module (`electron/shared/detail-meta.ts`).

## Options considered

- **Frontmatter per run**: keeps body clean, but frontmatter bloats and doesn't associate with specific blocks. Rejected.
- **Separate sidecar files per run**: avoids Markdown pollution, but breaks single-file portability. Rejected.
- **JSON code fence after runsql**: machine-readable, but ugly in GitHub/Obsidian preview. Rejected.
- **HTML `<detail>` after fence** (chosen): renders as invisible block in most viewers, human-readable in raw mode, stable round-trip via `detailRaw` preservation.

## Consequences

- `remark-detail-merge` absorbs `<detail>` into Milkdown code node attrs at parse time
- `detailRaw` is preserved verbatim during editing; only successful re-runs call `serializeDetail()`
- `block-id` enables stable history across re-executions
- History browsing and version diff are UI-only — they never write multiple `<detail>` blocks
- Shared `runsql-fences.ts` and `detail-meta.ts` used by editor, sql-index, and export
- Triggers re-evaluation if: a standard emerges for SQL-result metadata in Markdown (e.g. CommonMark extension)
