---
type: ADR
id: "0017"
title: "User-cancelled agent runs instead of iteration limits"
status: active
date: 2026-07-10
---

## Context

The harness agent previously stopped on `agentMaxIterations` or `agentWallClockMs`. In practice the wall-clock cap could stop long-running but healthy investigations after only a small number of tool turns, even when users raised the iteration setting. The UI already has an explicit Stop action, and the agent's dangerous operations remain gated by SQL guard and proposal confirmation.

## Decision

**Harness agent runs no longer end because of user-configured iteration or wall-clock caps.** They continue until the model finishes, an error occurs, or the user cancels the run.

## Options considered

- **User-cancelled runs** (chosen): removes a frustrating false stop and matches desktop expectations; users can stop runaway work from the panel.
- **Raise defaults / max values**: reduces but does not remove the failure mode, and keeps two confusing settings.
- **Adaptive timeout**: more code and still guesses how long a useful analysis should take.

## Consequences

- `agentMaxIterations` and `agentWallClockMs` are retained as legacy settings fields for settings-file compatibility, but are not used by the agent loop or shown in Settings.
- Long or looping agent runs consume provider/tool resources until the user cancels them.
- SQL mutations and note edits still require explicit user approval; removing run caps does not remove safety gates.
- Re-evaluate if users need per-run cost controls, provider-side budget caps, or automatic loop detection based on repeated tool calls.
