---
type: ADR
id: "0015"
title: "OpenAI-compatible chat provider without FIM inline completion"
status: superseded
superseded_by: "0018"
date: 2026-07-09
---

## Context

Supersedes [ADR-0011](0011-openai-compatible-provider-and-fim.md).

Stela still needs cloud LLM access for SQL rewrite/analysis actions and the agent harness, with API keys confined to the main process. ADR-0011 also shipped a separate Fill-in-the-Middle (FIM) path for RunSQL ghost-text completion. Measured upstream latency for DeepSeek-style FIM stayed ~0.7–1.3s before Stela debounce, which is too slow for inline completion UX. Alternative cloud FIM providers do not change that product constraint enough to keep the feature.

## Decision

**Keep the OpenAI-compatible chat/agent HTTP client in main; remove FIM inline completion entirely.** Chat and agent continue to use `{baseUrl}/chat/completions`. Do not expose `ai:fim-complete`, CM6 ghost-text FIM, or settings fields `inlineCompletionEnabled` / `fimBaseUrl` / `fimModel`. Schema/keyword autocomplete in RunSQL remains local (non-LLM).

## Options considered

- **Keep FIM and chase faster providers / local models**: possible latency wins, but adds ongoing product and ops cost for a feature that failed the “feel instant” bar. Rejected for now.
- **Keep FIM behind a flag**: dead code and settings surface with no ship path. Rejected.
- **Chat-only OpenAI-compatible provider, no FIM** (chosen): preserves action complete + agent; deletes the slow inline path.

## Consequences

- `providerMode`: `disabled` | `openai-compatible` | `cloud` (runtime path remains the OpenAI-compatible fetch client)
- Renderer configures via `window.stela.ai.configure` / `clearApiKey`; never reads the raw key
- Credential backend reports `safeStorage` or `plain` fallback when OS encryption is unavailable
- Existing vault `settings.json` may still contain legacy FIM keys; load/sanitize ignores them
- Re-evaluate only if a sub-300ms first-token FIM path (typically local small coder) becomes a product priority
