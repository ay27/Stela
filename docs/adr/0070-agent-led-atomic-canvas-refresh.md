---
type: ADR
id: "0070"
title: "Agent-led atomic Canvas refresh"
status: active
date: 2026-08-18
---

## Context

Analysis Canvas data-backed cards can render a newer SQL snapshot without
changing their structure, but Markdown conclusions and source-free Flow cards
encode interpretation rather than a deterministic projection. Extending direct
refresh to every card type would require a dependency graph, transformation
language, and per-card update semantics comparable to a reactive notebook.

## Decision

**Route whole-Canvas and single-source refresh actions through a dedicated
Agent run, and allow that run one atomic Canvas commit only after every targeted
source is bound to a successful audited query from the same run.**

The refresh request carries the target Canvas path and optional source id as
typed metadata. The Agent reads the complete artifact, reruns and repairs the
target queries when possible, and re-evaluates affected data views, narrative,
and Flow semantics. Any final target-query failure leaves the Canvas unchanged;
failed attempts remain visible in Agent and query history.

## Options considered

- **Agent-led atomic semantic refresh** (chosen): handles heterogeneous card
  semantics without a second execution language, at the cost of model latency,
  provider availability, and token usage.
- **Direct SQL source refresh**: fast and deterministic for KPI, chart, and
  table cards, but can present them beside stale Markdown and Flow conclusions.
- **Reactive Canvas dependency graph**: deterministic and schedulable, but
  turns Canvas into a notebook/dashboard runtime with substantially broader
  authoring, migration, and failure-state requirements.

## Consequences

- `canvas:refresh-source` and its preload API are removed. Canvas IPC remains
  limited to read, create, and user-owned Flow layout changes.
- `AgentRunRequest` gains a bounded Canvas refresh scope. The Canvas update tool
  verifies all targeted current sources have successful same-run bindings and
  rejects a second successful refresh commit.
- Full and single-source refresh buttons immediately open and run a dedicated
  Agent task. Successful updates continue to reload an already-open Canvas in
  place without changing the active Workspace tab.
- The version 1 Canvas schema does not change. Existing `lastError` fields stay
  readable for compatibility; a failed Agent refresh does not write new Canvas
  state, and a successful source binding clears its prior error.
- Scheduled or low-latency deterministic dashboard refresh would require a new
  decision introducing an explicit dependency model rather than overloading
  this Agent workflow.
