---
type: ADR
id: "0023"
title: "Streamed chat-model SQL inline completion"
status: active
date: 2026-07-20
---

## Context

Supersedes [ADR-0018](0018-pi-ai-agent-harness.md).

ADR-0018 replaced Stela's hand-written OpenAI-compatible client and agent loop with `@earendil-works/pi-ai` and `@earendil-works/pi-agent-core`, and deliberately omitted FIM inline completion. Users now need low-friction SQL suggestions inside RunSQL editors, but Stela still must support the chat models and provider profiles it already configures rather than introduce a second provider protocol.

The constraints retained from ADR-0018 are:

- `@earendil-works/pi-ai` remains the sole LLM transport, using pi built-in providers or Stela's custom OpenAI-compatible provider
- `AgentHarness` remains the agent loop, with in-memory `Session` / `InMemorySessionStorage`, proactive context compaction, and one provider-overflow recovery
- `@earendil-works/pi-ai` and `@earendil-works/pi-agent-core` remain exact-pinned at `0.80.6`
- API keys remain Stela-owned, wrapped via `safeStorage`, and never use pi's `auth.json`
- SQL mutation and note-edit proposals retain their guards and user confirmation
- Agent sessions remain in memory rather than becoming a new vault or Git authority
- `ai.contextWindow` keeps the 64K–1M presets and 128K default for model metadata and compaction budgeting
- Agent tools remain TypeBox `AgentTool`s; execution ordering follows [ADR-0021](0021-parallel-agent-tools-except-propose-edit.md)
- Existing action and agent APIs remain compatible, including additive `context_usage` and `compaction` agent events on the existing agent event channel
- The open-source build remains search-first, without RAG or MCP

## Decision

**Add streamed SQL inline completion on the existing pi-ai chat transport, reusing AI provider profiles while keeping its profile selection and IPC lifecycle independent from chat and agent activity.**

- Add vault settings `inlineCompletionEnabled` (default `false`) and `completionProfileId` (default `null`). `completionProfileId` must reference an existing `profiles` entry and is independent of `activeProfileId`; changing the active chat profile must not change the completion profile.
- Use `AI_INLINE_COMPLETION_START`, `AI_INLINE_COMPLETION_CANCEL`, and push event `ai:inline-completion-event`; preload exposes `window.stela.ai.startInlineCompletion`, `cancelInlineCompletion`, and `onInlineCompletionEvent`. Events are correlated by `requestId` and have `started`, `delta`, `final`, `error`, and `cancelled` variants.
- Build fast schema context only from referenced-table DDL found in the selected connection's local `schemaDir`. If no matching local snapshot is available, send no DDL and do not fall back to connector list/execute calls.
- Simulate FIM over pi-ai `streamSimple`: send bounded SQL before and after the cursor as explicit prefix and suffix prompt sections, and stream only the insertion text back to the editor.
- In RunSQL, debounce by 120 ms, cancel replaced or dismissed requests, ignore stale request/cursor events, accept ghost text with Tab, dismiss it with Escape, and suppress it while native completion popup or IME composition is active.
- Retain the pi-ai transport and `AgentHarness` decisions above. Inline completion is a one-shot streamed transport call and does not enter AgentHarness sessions or the agent tool loop.

## Options considered

- **Dedicated FIM endpoint/model protocol**: can provide native infill semantics, but duplicates provider configuration and revives the separate transport rejected by ADR-0018. Rejected.
- **Chat-model simulated FIM over pi-ai `streamSimple`** (chosen): reuses profiles, credentials, and provider compatibility; prompt quality and latency depend on the selected chat model.
- **Use `activeProfileId` for completion**: fewer settings, but switching Agent chat would silently change a latency-sensitive editor feature. Rejected.
- **Connector schema introspection on each request**: richer context, but adds unpredictable database latency and access during typing. Rejected in favor of local `schemaDir` only.
- **Reuse action or agent IPC**: fewer channel constants, but cancellation and concurrent request correlation become ambiguous. Rejected in favor of a dedicated lifecycle.

## Consequences

- Inline completion works with existing configured profiles and per-profile safeStorage credential shards; no new provider dependency or secret store is introduced.
- Chat/agent profile changes and completion profile changes are independent. Deleting the selected completion profile clears `completionProfileId` and disables inline completion.
- Sanitization disables completion unless both the enable flag is true and the selected completion profile exists, preserving compatibility with old or malformed settings files.
- The editor can cancel stale requests and consume incremental text without coupling to agent sessions.
- Local schema-only enrichment avoids connector traffic while typing, but suggestions have less context when `schemaDir` is absent or stale.
- Chat-based FIM may include unwanted prose or duplicate suffix text; prompt shaping and output cleanup must stay bounded and deterministic.
- Exact-pinned pi-ai and pi-agent-core, shared profile-backed transport, in-memory AgentHarness sessions, context usage/compaction events, and existing safety boundaries remain unchanged.
- Re-evaluate if pi-ai exposes a portable native FIM API, chat-model latency is unacceptable, local schema snapshots cannot provide adequate completion quality, multi-provider OAuth UX is required, sessions must survive restart/sync, or a pi major version breaks Electron packaging.
