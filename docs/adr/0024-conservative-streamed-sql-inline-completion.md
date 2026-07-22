---
type: ADR
id: "0024"
title: "Conservative streamed SQL inline completion"
status: active
date: 2026-07-21
---

## Context

Supersedes [ADR-0023](0023-streamed-chat-sql-inline-completion.md).

ADR-0023 reintroduced RunSQL inline completion through the shared pi-ai chat
transport. Its 120 ms trigger also ran after focus and selection changes, while
multi-line ghost text participated in CodeMirror layout. In practice this made
completion appear on click, caused RunSQL block height jumps, and amplified
spacing mistakes from latency-oriented chat models.

The retained constraints are unchanged: pi-ai remains the sole LLM transport,
AgentHarness remains the in-memory agent loop, credentials stay in main via
safeStorage, action and agent APIs remain compatible, and the open-source build
remains search-first without RAG or MCP.

## Decision

**Keep profile-backed streamed chat completion, but make its RunSQL interaction conservative and layout-stable.**

- Keep `completionProfileId` independent from chat/agent `activeProfileId`, with
  the same per-profile safeStorage credentials.
- Keep dedicated `AI_INLINE_COMPLETION_START`,
  `AI_INLINE_COMPLETION_CANCEL`, and `ai:inline-completion-event` IPC with
  request correlation and cancellation.
- Keep bounded prefix/suffix context, referenced-table DDL from local
  `schemaDir` only, and up to 8K characters of nearest-first sibling RunSQL
  blocks. Missing snapshots never fall back to connector access.
- Use pi-ai `streamSimple` with a 48-token output cap and a prompt requiring one
  insertion line with any necessary leading whitespace.
- Trigger only after actual typing or paste, wait 600 ms, and require the cursor
  to be at the end of the current line apart from trailing whitespace. Focus,
  click, selection changes, settings changes, and native completion popup
  closure do not start a request.
- Display and accept at most one ghost-text line. Tab accepts it; Escape, blur,
  composition start, editor destruction, document replacement, or cursor
  movement cancels it.

## Options considered

- **Immediate multi-line automatic completion**: maximizes suggestion volume,
  but creates focus-triggered noise and layout movement. Rejected.
- **Conservative single-line automatic completion** (chosen): trades suggestion
  frequency for lower distraction and stable layout.
- **Manual shortcut only**: eliminates unsolicited requests, but adds friction
  to every completion. Deferred if conservative automatic completion remains
  too noisy.
- **Floating multi-line overlay**: avoids layout changes, but adds positioning,
  clipping, and accessibility complexity. Rejected for now.

## Consequences

- Clicking into RunSQL no longer starts a model request.
- Ghost text cannot increase block height, and shorter output reduces cost and
  over-generation.
- Completion no longer supports middle-of-line or multi-line suggestions; users
  must continue typing or move to a line tail before it can trigger.
- Model-specific spacing errors remain possible, but the prompt now explicitly
  requires insertion-boundary whitespace.
- Re-evaluate if users prefer manual invocation, a reliable native FIM model is
  available, or a stable accessible overlay becomes necessary.
