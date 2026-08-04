---
type: ADR
id: "0052"
title: "Signal-focused Agent observability"
status: active
date: 2026-08-04
---

## Context

Supersedes [ADR-0051](0051-local-agent-observability-store.md).

The initial local observability store captured SQL inline-completion requests
and acceptance dispositions alongside Agent behavior. Inline completion is a
high-frequency, short-lived interaction that overwhelms diagnostic traces and
grows the local store without helping Agent optimization. At the same time,
local knowledge Skills are surfaced and loaded by the Agent but their actual
selection rate is invisible. The recent trace view also needs bounded navigation
instead of returning an arbitrary fixed batch with the dashboard aggregate.

## Decision

**Do not persist inline-completion metrics; measure local Skill candidate
exposure and successful loading per Agent run, and retrieve diagnostic traces
through cursor pagination with a fixed ten-row UI page.** Existing inline metric
runs are removed when the local observability store migrates to schema version 2.

## Options considered

- **Signal-focused Agent metrics** (chosen): keeps traces useful and adds a
  candidate-to-use Skill funnel; intentionally gives up inline-completion
  reliability and acceptance history.
- **Retain inline aggregates but discard traces**: preserves some completion
  telemetry, but the event/IPC lifecycle and high-frequency writes remain.
- **Sample inline requests**: bounds volume, but sampled acceptance rates are
  harder to explain and still do not address missing Skill-use visibility.

## Consequences

- Inline completion continues to function but no longer writes observability
  runs, prompt traces, token usage, or renderer disposition events.
- Skill usage rate is the share of distinct Agent-run candidate matches that
  were successfully loaded; repeated searches are deduplicated for the rate,
  while successful load calls remain visible as usage volume.
- Historical inline metrics are deleted locally during migration and cannot be
  recovered from Git.
- Trace pagination remains local, range-bounded, cursor-based, and limited by
  the existing typed IPC contract.
- Re-evaluate if completion quality requires a dedicated low-volume evaluation
  workflow rather than production interaction telemetry.
