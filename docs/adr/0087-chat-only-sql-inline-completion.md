---
type: ADR
id: "0087"
title: "Chat-only SQL inline completion transport"
status: active
date: 2026-09-03
---

## Context

Supersedes [ADR-0080](0080-guarded-native-fim-inline-completion.md).

ADR-0080 routed the official DeepSeek V4 Flash profile to a provider-specific,
non-streaming native FIM endpoint while leaving every other completion profile
on pi-ai's streamed Chat transport. In practice, that special path produced a
poor interactive experience: requests often appeared not to trigger, native
responses could not surface partial text, and the provider-specific behavior
made the configured completion profile insufficient to explain the actual
request path.

A fixed local evaluation built from real Vault SQL showed that bounded Chat
prompts can produce useful short insertions without a native FIM protocol. The
remaining quality and latency work benefits from one comparable transport for
all providers rather than a DeepSeek-only runtime branch.

## Decision

**Route every SQL inline-completion profile through the existing bounded,
reasoning-off, streamed pi-ai Chat transport. The application runtime no longer
selects or calls a native FIM endpoint.**

- Official DeepSeek profiles follow the same Chat path as built-in and Custom
  profiles.
- Prefix, suffix, compact schema, nearby SQL, heading, and prose remain explicit
  sections of the bounded insertion prompt.
- The typed start/cancel/event IPC, independent `completionProfileId`, schema
  availability gate, editor debounce, renderer cache, candidate validation, and
  insertion normalization remain unchanged from ADR-0080.
- A provider failure ends that attempt; Stela does not issue a second automatic
  request through another transport.
- The explicit offline evaluator may retain an opt-in native-FIM adapter for
  historical comparison, but it is not reachable from the application runtime.

## Options considered

- **One streamed Chat transport for every profile** (chosen): makes routing
  predictable and provider-neutral, preserves partial-response support, and
  keeps evaluation conditions comparable; native infill semantics are lost.
- **Keep native FIM for official DeepSeek**: preserves real prefix/suffix fields,
  but retains the non-streaming provider-specific path whose measured product
  experience motivated this change.
- **Try native FIM first and fall back to Chat**: can increase display coverage,
  but adds latency, duplicate billing risk, and two incomparable generations for
  one editor action.

## Consequences

- Selecting a completion profile now fully determines the provider/model used;
  there is no hidden DeepSeek transport override.
- Chat responses can stream internally, although Stela continues buffering the
  bounded candidate until deterministic validation completes.
- Middle-of-SQL insertion depends on prompt adherence instead of a native FIM
  contract. The fixed evaluation set must track this quality explicitly.
- Provider latency, queueing, and server-default thinking behavior can still
  differ. Completion evaluation must continue reporting visibility, useful
  output, timeout rate, and latency-budgeted usefulness separately.
- Re-evaluate native FIM only if a portable provider capability and measured
  interactive latency justify reintroducing a product runtime branch.
