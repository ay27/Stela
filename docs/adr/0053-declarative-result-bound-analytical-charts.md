---
type: ADR
id: "0053"
title: "Declarative result-bound analytical charts"
status: active
date: 2026-08-05
---

## Context

Stela notes already render Mermaid diagrams, but data analysis needs quantitative
charts that stay connected to auditable RunSQL results. Letting an Agent emit
arbitrary JavaScript or raw ECharts options would create an unsafe, unstable
Markdown contract. Copying result rows into chart blocks would also duplicate
the JSONL execution authority and make charts stale after a query rerun.

Static Markdown export must remain readable outside Stela without granting the
renderer arbitrary filesystem access.

## Decision

**Represent analytical charts as a versioned, Zod-validated `stela-chart` JSON
fence, bind it to a run result or the immediately preceding RunSQL block, and
render the controlled spec through lazily loaded ECharts SVG modules.** Export
Markdown and generated SVG assets together through a dedicated typed bundle IPC.

## Options considered

- **Controlled Stela spec translated to ECharts** (chosen): provides the chart
  types Stela needs while keeping Markdown compact, safe, and extensible; it
  requires maintaining a small translation layer.
- **Expose raw ECharts options**: maximizes ECharts coverage but gives Agents a
  large unstable surface and makes validation ineffective.
- **Use Vega-Lite directly**: has a strong declarative grammar for statistical
  charts, but is less suited to Stela's funnel-oriented analysis and would still
  require a source-binding and export contract.
- **Extend Mermaid only**: reuses an existing dependency but lacks the data
  mapping, interactivity, and quantitative chart coverage required here.

## Consequences

- Chart fences remain Git-readable and never embed arbitrary scripts or copied
  result rows. JSONL remains result authority and SQLite remains a disposable
  read cache.
- Conversation charts use an exact `runId`; note charts normally follow the
  latest result metadata on the immediately preceding RunSQL block and may keep
  a `fallbackRunId` for their first preview.
- Agent-created charts are validated against the actual result schema and rows
  before being shown. Large results must be aggregated or filtered in SQL rather
  than silently sampled.
- ECharts becomes a direct dependency, but it is loaded only when a chart is
  rendered and only the registered chart/component modules are used.
- Markdown bundle export adds a narrowly typed process-boundary capability. Main
  derives the assets directory from the user-selected destination and creates
  unique SVG files without deleting existing assets.
- Re-evaluate the chart catalog when real notes require correlation, heatmap,
  boxplot, hierarchy, or flow types beyond the initial controlled set.
