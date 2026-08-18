---
type: ADR
id: "0072"
title: "Profile-scoped Agent reasoning effort"
status: active
date: 2026-08-18
---

## Context

Stela's main `AgentHarness`, headless Agent evaluations, and adaptive strategy
review were all configured with thinking disabled. The Dashboard could report
that state, but users could not choose the reasoning budget, and earlier
DataAgentBench results did not identify this important experimental condition.
Reasoning support is model-specific: built-in pi models publish supported
levels, while Custom OpenAI-compatible endpoints cannot be discovered safely.

## Decision

**Store a requested reasoning effort on every AI Profile, resolve it to the
selected model's supported level for the main Agent chain, and record both the
requested and effective values in traces and headless evaluation artifacts.**

The allowed levels are `off | minimal | low | medium | high | xhigh | max` and
the migration/default is `medium`, including existing Custom Profiles. Built-in
models offer only catalog-supported levels and clamp stale settings explicitly.
For Custom endpoints, selecting a non-`off` level declares support for the
standard `reasoning_effort` request field; endpoint rejection is surfaced and
never silently retried without reasoning. Context compaction and strategy
review inherit the main Agent's effective level. Inline completion, quick
one-shot actions, and Skill maintenance remain `off`.

## Options considered

- **Profile-scoped effort with explicit capability resolution** (chosen): keeps
  model behavior reproducible across product runs and evaluations, but adds a
  profile migration and provider-specific error surface.
- **One global Agent setting**: simpler to expose, but switching profiles could
  silently select an unsupported or inappropriate level.
- **Provider-selected defaults**: avoids configuration, but makes regressions
  and benchmark comparisons ambiguous and repeats the previous hidden `off`
  condition.
- **Always enable maximum reasoning**: easy to describe, but ignores latency,
  cost, model support, and user intent.

## Consequences

- Existing and new Profiles resolve missing effort to `medium`; some Custom
  endpoints may begin rejecting Agent requests until the user selects `off` or
  configures a compatible endpoint.
- The existing AI settings/status DTO and Zod validation grow additively; no new
  IPC channel, process boundary, secret, or storage authority is introduced.
- Dashboard traces and evaluation outputs can distinguish requested policy from
  the model's effective level. Provider-returned thinking text remains optional
  and is not proof that reasoning was disabled.
- DataAgentBench resume cannot mix different effort conditions; legacy results
  without metadata are interpreted as `off`.
- Re-evaluate if Custom endpoints need an explicit compatibility toggle or if a
  provider introduces reasoning controls that cannot map to these levels.
