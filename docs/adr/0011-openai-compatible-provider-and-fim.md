---
type: ADR
id: "0011"
title: "OpenAI-compatible chat provider with separate FIM endpoint"
status: superseded
superseded_by: "0015"
date: 2026-06-01
---

## Context

Stela needs cloud LLM access for SQL rewrite, analysis, inline completion, and the agent harness. Users run different providers (OpenAI, DeepSeek, local gateways). API keys must never reach the renderer. Inline SQL completion needs a fill-in-the-middle (FIM) API that is not the same as chat completions.

## Decision

**Talk to providers through an OpenAI-compatible HTTP surface from the main process.** Chat/agent calls use `{baseUrl}/chat/completions`. Inline SQL completion uses a **separate** `{fimBaseUrl}/completions` FIM endpoint with its own `fimModel`. API keys are stored in per-device vault secret shards (`{vault}/.stela/secrets/ai_{slug}.json`) via `safeStorage`; settings only expose `hasApiKey`.

## Options considered

- **Vendor SDKs (OpenAI/Anthropic/etc.)**: richer APIs, but multiplies dependencies and lock-in. Rejected.
- **Single endpoint for chat + FIM**: simpler settings, but DeepSeek and similar FIM models require a distinct `/beta` completions base. Rejected.
- **OpenAI-compatible chat + separate FIM settings** (chosen): one HTTP client shape, portable across gateways, FIM remains opt-in (`inlineCompletionEnabled`).

## Consequences

- `providerMode`: `disabled` | `openai-compatible` | `cloud` (settings enum; runtime path is the OpenAI-compatible fetch client)
- Renderer configures via `window.stela.ai.configure` / `clearApiKey`; never reads the raw key
- FIM defaults target DeepSeek-style `/beta` completions; users can point elsewhere
- Credential backend reports `safeStorage` or `plain` fallback when OS encryption is unavailable
- Triggers re-evaluation if: a major provider requires non-compatible streaming/tool protocols that the thin fetch client cannot express
