---
type: ADR
id: "0084"
title: "Single action-based execution-plan tool"
status: active
date: 2026-08-29
---

## Context

Supersedes [ADR-0078](0078-plans-as-progress-bookkeeping.md) without changing its
core decision that plans are progress bookkeeping and never an answer gate.

ADR-0078 exposed `create_plan`, `update_plan`, and `get_plan` as three model
tools. They operate on one bounded runtime store, share one sequential execution
mode, and differ only in the action-specific fields they consume. Their separate
names and repeated object-schema shells enlarge the fixed provider tool list.
`get_plan` also invites routine reads even though the current plan is projected
into session context and normally needs no recovery call.

## Decision

**Expose one sequential `plan` tool with `action=create|update|get`; retain the
same progress-only store, immutable session snapshots, non-gating semantics, and
note-returning tolerant updates established by ADR-0078.**

`create` consumes `steps`, `update` consumes `stepId`, `status`, optional
`evidence`, and optional `runId`, and `get` recovers state only when session
context is insufficient. Routine lookups do not create plans, and no plan action
grants authority over the answer.

The old three names remain accepted by internal dispatch for historical session
traces and tests, but are absent from the provider-facing tool list. Because
failure counters are keyed by advertised tool name, the three new actions share
one circuit-breaker counter; this is acceptable for optional bookkeeping and
does not terminate the run or block any analytical tool.

## Options considered

- **One action-based plan tool** (chosen): removes repeated schema shells and
  presents one cohesive capability. It weakens action-specific schema
  requirements and shares failure accounting across actions.
- **Keep three tools**: gives each action the narrowest possible schema and
  breaker key, but permanently spends context on three names for one store.
- **Remove plans**: smallest surface, but removes the visible progress card that
  motivated retaining plans in ADR-0078.

## Consequences

The provider-facing tool count falls while existing plan persistence and UI
events remain unchanged. Runtime dispatch validates fields after selecting the
action, so malformed combinations fail with action-specific messages. Historical
calls continue to replay, but new model traffic uses only `plan`.

Any future plan action must justify expanding this union. If actions acquire
different approval, parallelism, or security boundaries, split tools should be
reconsidered instead of growing a broad command endpoint.
