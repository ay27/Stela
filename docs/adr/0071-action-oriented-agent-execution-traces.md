---
type: ADR
id: "0071"
title: "Action-oriented Agent execution traces"
status: active
date: 2026-08-18
---

## Context

The Session-oriented Agent Dashboard originally projected system prompts, user
input, business context, model calls, tools, maintenance, and unmatched metric
events into one ordered list. This mixed causal work with inputs, token gauges,
lifecycle bookkeeping, and persistence notifications. It also exposed raw
event names such as `context_usage` as if they were executable steps, while the
actual model request was missing because a provider hook was observed through
the wrong subscription API.

## Decision

**Project only causal Agent actions as execution-trace nodes: model calls, tool
executions, user approvals, strategy reviews, and context compactions. Treat
inputs, usage, timing, side effects, and raw events as action details; show Skill
maintenance in a separate post-answer section.**

Model calls capture provider-neutral context and the final provider payload
through dedicated Harness hooks. Their details own readable input/output,
provider-reported token usage, context-window capacity, timing, side effects,
and bounded raw diagnostic data. Unknown metric events remain available as
diagnostics but do not automatically become trajectory nodes.

## Options considered

- **Action-oriented trace** (chosen): keeps the causal chain readable while
  retaining detailed local diagnostics on the action that produced them.
- **Mixed event timeline**: requires less projection logic, but exposes
  implementation bookkeeping and duplicates model/tool lifecycle records.
- **Raw event timeline behind a mode switch**: preserves every internal event
  as a second interface, but adds another navigation model without improving
  the default diagnosis flow.

## Consequences

- New metric event kinds may be added without appearing in the primary trace
  until they receive an explicit action or attachment projection.
- Existing trace storage, retention, redaction, IPC, and database schema remain
  unchanged; older traces degrade to unavailable inputs rather than fabricated
  values.
- Model-context capture adds bounded local diagnostic payloads and therefore
  increases the observability database size for new runs.
- Re-evaluate if trace payload volume requires per-event sampling or if users
  need a dedicated raw-event debugger.
