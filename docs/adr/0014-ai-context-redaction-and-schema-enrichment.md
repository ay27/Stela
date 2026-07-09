---
type: ADR
id: "0014"
title: "AI context assembly with redaction and schema enrichment"
status: active
date: 2026-06-25
---

## Context

Action prompts and agent turns need enough schema/SQL/result context to be useful, without shipping secrets or entire result sets to a remote provider. Context comes from the open note, RunSQL block, connector metadata, optional `@table` mentions, and related run history.

## Decision

**Assemble prompts in main via a bounded, redacted context pipeline:**

1. Enrich connector dialect + schema targets (`schema-context.ts`) from SQL symbols and `mentionedTables`
2. Cap note/SQL/DDL/sample sizes (`context-builder.ts`)
3. Optionally attach sampled result rows only when `sendResultSamples` is on, capped by `maxSampleRows`
4. Run `redactForPrompt` over the bundle (secret-looking keys and token-shaped values → `***redacted***`)
5. Build action-specific system/user prompts (`prompt-builder.ts`)

Full result sets and raw API keys never leave the machine as prompt payload.

## Options considered

- **Send whole notes + full result grids**: highest model accuracy, worst privacy/cost. Rejected.
- **Schema-only, never samples**: safer, but explain-result / anomaly actions become weak. Rejected as hard rule.
- **Bounded + user-gated samples + redaction** (chosen): useful defaults with explicit toggles.

## Consequences

- Related runs are ranked by SQL symbol overlap / connection / note path, not embeddings
- Prompt debug logs go through the same redaction path
- Users can disable samples entirely in Settings → AI
- Complements ADR-0008 (no on-device RAG) and ADR-0011 (secrets stay in main)
- Triggers re-evaluation if: enterprise customers require allowlisted column policies beyond heuristic redaction
