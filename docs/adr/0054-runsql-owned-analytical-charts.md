---
type: ADR
id: "0054"
title: "RunSQL-owned analytical charts"
status: superseded
date: 2026-08-05
superseded_by: "0055"
---

## Context

Supersedes [ADR-0053](0053-declarative-result-bound-analytical-charts.md).

Standalone `stela-chart` fences made a chart look like an independent Markdown
node even though its data, lifecycle, and validity all belonged to one RunSQL
result. Saving an Agent chart also duplicated SQL because the chart fence could
only refer to a neighboring block indirectly. Stela needs a portable Markdown
contract without hidden query blocks, copied rows, or editor-only association
state.

## Decision

**Store at most one validated chart configuration inside each RunSQL block's
following `<detail>`, strongly associated by the same `blockId`, and render it
inside that RunSQL result panel.** Conversation charts may use an exact `runId`
as transport, but standalone chart fences are not a note abstraction.

## Options considered

- **RunSQL-owned chart in `<detail>`** (chosen): keeps SQL, result metadata, and
  visualization in one round-tripped node; `<detail>` must support a pending
  chart before the first successful execution.
- **Standalone chart fence**: keeps chart source directly editable, but adds a
  second node whose ordering and source association the editor must maintain.
- **Hidden RunSQL plus visible chart**: simplifies some presentation paths but
  makes Markdown surprising and duplicates query ownership.

## Consequences

- One RunSQL has zero or one chart. Saving another chart replaces the existing
  configuration after the normal note-edit approval.
- The chart config stores no SQL, result rows, or run id. Its block association
  is validated against the enclosing detail; execution history remains the data
  authority.
- A pending detail may contain only `block-id` and `chart`. Successful execution
  fills result metadata while preserving the chart.
- Historical browsing renders the same chart definition against the selected
  run; compare mode omits it. Schema or data drift produces a visible chart
  error instead of stale or partial output.
- Markdown export emits the result table plus SVG and never exposes the internal
  chart JSON. No compatibility migration is provided because ADR-0053 was not
  released.
