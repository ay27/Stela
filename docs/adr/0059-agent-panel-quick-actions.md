---
type: ADR
id: "0059"
title: "Agent Panel quick actions instead of one-shot AI actions"
status: active
date: 2026-08-11
---

## Context

Supersedes [ADR-0014](0014-ai-context-redaction-and-schema-enrichment.md).

RunSQL rewrite, error repair, SQL questions, and schema explanation used a
separate `ai:complete` prompt pipeline and bespoke inline/modal result UIs.
Those prompts duplicated Agent policy, could not use live Agent tools, and
diverged from the persistent Agent Panel experience. Rewrite actions must still
preserve the current block-level diff and explicit accept/discard flow,
including for unsaved editor content.

## Decision

**Route every visible scoped AI action through a new Agent Panel conversation
with bounded, redacted structured attachments, and replace direct RunSQL
rewrites with a typed `runsql_rewrite` Agent proposal that the renderer previews
and applies only after explicit approval. Remove the public `ai:complete`
capability.**

Error repair and schema explanation submit immediately. Rewrite/optimization
and SQL questions open editable localized prompt drafts. SQL, errors, table
references, and rewrite targets travel as structured context rather than being
duplicated into template prose. SQL inline completion and the deterministic
natural-language-to-SQL-index translator remain separate narrow model paths.

## Options considered

- **Agent Panel quick actions** (chosen): one interaction model, live tools,
  reusable sessions and cacheable policy; requires a block-target registry and
  a new proposal kind.
- **Keep action complete beside Agent**: preserves the smallest rewrite path,
  but retains duplicated prompts, APIs, metrics, and UI.
- **Return SQL only in chat**: simplest migration, but removes the existing
  safe inline diff and makes users copy changes manually.
- **Use note-edit proposals**: reuses an existing tool, but is unsafe for dirty
  editor state and loses RunSQL block-level review.

## Consequences

- `window.stela.ai.complete`, `AiActionKind`, and the action prompt/context
  pipeline are removed; historical `ai_action` metrics remain readable.
- A RunSQL rewrite proposal is bound to an exact renderer target and original
  SQL snapshot. Missing, destroyed, or changed targets cannot be overwritten.
- Quick actions intentionally create and focus a new Agent tab because they are
  explicit user navigation, while ordinary Canvas update behavior is unchanged.
- Result-sample settings used only by the removed action pipeline are retired;
  old persisted keys are ignored safely.
- Re-evaluate if a future scoped action needs deterministic sub-second output
  that cannot tolerate an Agent turn or tool proposal.
