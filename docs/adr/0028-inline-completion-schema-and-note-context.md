---
type: ADR
id: "0028"
title: "Inline completion reads renderer column cache and note context"
status: active
date: 2026-07-25
---

## Context

Supersedes [ADR-0024](0024-conservative-streamed-sql-inline-completion.md).

ADR-0024 kept RunSQL inline completion conservative and layout-stable, and
restricted its schema context to DDL found in the connection's local
`schemaDir`. That restriction produced a visible inconsistency inside a single
editor: the local CodeMirror popup already knows the real columns of the table
under the cursor, because `column-cache` fetched them with a `LIMIT 0` probe,
while the AI suggestion for the same line was guessing column names — the main
process could only see tables that happen to have a `db.table.md` document.

Two further gaps: the SQL text alone does not contain the section's business
intent (magic values, metric definitions, and "count only X" caveats live in the
surrounding prose), and the documented debounce (600 ms) never matched the
implemented one (120 ms).

Retained from ADR-0024 without change: pi-ai as the sole LLM transport,
credentials in main via safeStorage, `completionProfileId` independent of chat
and agent `activeProfileId`, the dedicated start/cancel/event IPC trio, one
ghost-text line, trigger only after an edit with the cursor at a line tail, and
no fallback to connector list/execute calls from the completion path.

## Decision

**Let the renderer send the column metadata it has already cached, plus the nearest heading and a short prose excerpt, and align the documented debounce with the implemented 120 ms.**

- `AiInlineCompletionRequest` gains optional `tableSchemas` (up to 8 tables,
  200 columns each), `heading`, and `prose` (500 characters), all validated by
  the existing Zod schema for `AI_INLINE_COMPLETION_START`.
- The renderer sends **only already-cached** columns for tables parsed out of the
  cursor's FROM/JOIN scope. It never issues a probe to build a request, so first
  token latency is unaffected.
- Cache warming happens on block focus instead: gaining focus parses the same
  scope and fires `ensureColumnsFor()` without awaiting. This also warms the
  local popup, which previously paid the probe round trip on first use.
- In main, renderer columns take precedence over `schemaDir` DDL for the same
  table, and `schemaDir` supplies tables the cache does not have. A table that
  has a DDL snippet contributes only its DDL to the prompt (the snippet already
  contains columns and comments); a cache-only table contributes a column list.
- Prompt gains a `Surrounding note context` section carrying heading and prose.
- Debounce is 120 ms in code and in the docs. Ghost text is an ignorable
  suggestion, and 600 ms measurably feels late.
- Tab accept and Escape dismiss write a local dev-only log line. Nothing is
  reported anywhere.

## Options considered

- **Renderer sends cached columns** (chosen): closes the popup-versus-AI gap
  with no new IPC surface and no added latency; the cost is a wider request
  payload and a second schema source to reconcile.
- **Main queries the connector for columns**: authoritative and renderer-free,
  but ADR-0024 deliberately forbids connector calls on the completion path, and
  a probe on the critical path adds 100–300 ms to first token.
- **Preload exposes the column cache to main on demand**: another round trip
  during a latency-critical request, for data the renderer already holds.
  Rejected.
- **Whole note as context**: strictly more information, but it crowds out schema
  in the prompt budget and drags in unrelated sections. Rejected in favour of
  nearest heading plus two paragraphs.
- **Debounce 600 ms** (as documented): fewer requests, but suggestions arrive
  after the user has already typed past them.

## Consequences

- Suggestions can reference columns of tables that have no schema document,
  which is the common case for ad-hoc tables.
- Two schema sources now feed one prompt; a stale `schemaDir` document and a
  fresh probe can disagree, resolved by preferring the probe for columns while
  keeping the document's DDL comments.
- Focus now triggers a connector probe (not a model request — ADR-0024's rule
  that focus never starts a completion still holds). On a slow warehouse this is
  background work the user does not wait for, but it is a request they did not
  explicitly ask for.
- Note context leaks prose into the prompt, so redaction applies to it through
  the same `redactForPrompt` path as SQL.
- Completion quality is measurable via `npm run eval:completion`, including
  `--no-note-context` for an A/B and `--dry-run` for a token-free prompt
  inspection.
- Re-evaluate if payload size becomes a problem, if the two schema sources drift
  in confusing ways, or if focus-time probes prove too costly on remote
  warehouses.
