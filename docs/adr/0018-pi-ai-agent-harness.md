---
type: ADR
id: "0018"
title: "pi-ai transport and AgentHarness for AI provider and agent loop"
status: active
date: 2026-07-13
---

## Context

Supersedes [ADR-0012](0012-dual-ai-surfaces-actions-and-agent.md) and [ADR-0015](0015-openai-compatible-provider-without-fim.md) for the provider HTTP client and agent orchestration implementation. Dual AI surfaces (action complete + harness agent) and the no-FIM product choice remain; only the transport and loop implementation change.

Stela's hand-rolled `fetch` → `/chat/completions` client and `for(;;)` agent loop work, but lack mature streaming protocol handling, context overflow recovery, and session compaction. `@earendil-works/pi-ai` and `@earendil-works/pi-agent-core` provide a unified LLM API and a full AgentHarness (session tree, tools, compaction) that is substantially more mature than our custom loop.

Constraints that must not regress:

- API keys stay in main via `safeStorage` (not pi's `auth.json`)
- SQL guard + proposal confirmation for mutations / note edits
- Existing IPC channels and renderer timeline event shapes (plus small additive status events)
- Sessions remain in-memory (not a new vault/Git authority)
- Open-source gate: no RAG / MCP / FIM

## Decision

**Use `@earendil-works/pi-ai` as the sole LLM transport and `@earendil-works/pi-agent-core`'s `AgentHarness` as the agent loop, behind Stela-owned credentials, tools, and IPC.** Keep OpenAI-compatible `baseUrl` + `model` + API key settings; add a user-configured `contextWindow` for compaction budgeting. Sessions use in-memory `Session` / `InMemorySessionStorage`. Compact proactively before prompts when over budget, and once on provider context overflow. Expose approximate context usage and compacting status to the Agent Panel via additive `AgentEvent`s.

## Options considered

- **Hand-rolled loop + fetch** (previous): smallest dependency surface, but owns protocol quirks, tool-call parsing, and compaction ourselves. Rejected for ongoing maintenance cost.
- **pi-ai + low-level `Agent` only**: enough for the tool loop, but loses session tree / compaction APIs that AgentHarness already ships. Rejected once compaction was a product requirement.
- **pi-ai + AgentHarness + in-memory sessions** (chosen): mature harness without inventing a new on-disk authority. Volume cost of pi SDKs accepted; pin exact versions.
- **AgentHarness + vault/userData JSONL persistence**: useful later, but introduces a third history store and Git questions. Deferred.

## Consequences

- Exact-pin `@earendil-works/pi-ai@0.80.6` and `@earendil-works/pi-agent-core@0.80.6`; Electron main bundle grows by several MB of provider SDKs (tree-shake to OpenAI-completions path where possible)
- Action complete and agent share one pi `Models` / custom OpenAI-compatible provider; FIM remains absent
- `ai.contextWindow` (64K–1M presets, default 128K) drives Model metadata and compaction thresholds
- Tool defs move to TypeBox `AgentTool` with `executionMode: "sequential"` so proposal waits stay ordered
- Additive `AgentEvent` kinds: `context_usage`, `compaction` — no new IPC channels
- Re-evaluate if: multi-provider OAuth UX is required, sessions must survive restart / sync, or pi major versions break the Electron packaging story
