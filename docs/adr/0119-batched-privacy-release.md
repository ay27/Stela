---
type: ADR
id: "0119"
title: "Batch privacy release decisions per assistant step"
status: active
date: 2026-09-25
---

## Context

ADR-0118 requires manual, source-scoped release. Multiple release tool calls in
one assistant step currently block sequentially, asking the user repeatedly.

## Decision

**Main collects the release calls in a completed assistant message before tool
execution and presents one grouped proposal for that batch.** Up to 16 requested,
available results share one decision. Each option binds to its own immutable
result, column and JSON path. The user can allow selected fields, allow all
displayed options or reject all. Nothing is selected initially. Later tool calls
in that batch reuse the decision, including rejection; new steps get no blanket
approval. A larger batch fails closed and asks the agent to narrow its scope.

Single-result persisted proposals remain readable. Answers remain explicit
option-ID arrays, bounded to 20,000 characters on both proposal IPC routes. Main
validates the complete selection before granting anything. Cancellation, timeout,
task disposal and invalid answers grant nothing. ADR-0118's transport projection,
masked history and task lifetime remain unchanged.

## Options considered

- **Collect completed assistant tool calls (chosen):** no debounce, no deadlock
  with sequential execution, and only explicitly requested sources are included.
- Debounce executing tools: deadlocks while the first sequential tool waits.
- Include every prior query: unnecessarily broadens the requested authority.

## Consequences

One step needs one decision instead of one per result. Sources discovered in a
later step still require a new decision. The agent is instructed to submit all
known release needs in the same step. Grouped previews can be longer, so the UI
retains bounded scrolling and source labels.
