---
type: ADR
id: "0057"
title: "Bounded mark-encoding visualizations"
status: active
date: 2026-08-07
---

## Context

[ADR-0056](0056-user-adjustable-react-flow-cards.md) keeps charts as structured
Canvas and Agent-timeline presentation. The original chart-type-specific
contract was easy to validate, but each new analytical shape required another
top-level schema branch and duplicated formatting rules across charts, KPIs,
and tables. Accepting arbitrary ECharts or Vega specifications would remove
those limits at the cost of unsafe, unstable, renderer-owned protocol details.

## Decision

**Use a Stela-owned chart v2 grammar composed from an analytical preset,
semantic fields, and one or two bounded mark/encoding layers, compiled locally
to ECharts, with a shared value-format contract for chart, KPI, and table
fields.**

Presets express intent (`trend | ranking | composition | distribution |
correlation | funnel | retention | comparison | custom`), while controlled
marks (`bar | line | area | point | arc | rect | rule | histogram | boxplot |
funnel`) map named fields to encoding channels. At most two compatible layers
share one x field and may use left/right y axes.

## Options considered

- **Stela preset plus mark/encoding grammar** (chosen): covers common analytical
  views while keeping validation, export, and Agent prompting bounded.
- **Continue chart-type-specific fields**: simplest for a small set, but grows
  combinatorially for layered and less common analytical views.
- **Embed Vega-Lite**: mature grammar, but adds a second visualization runtime
  and exposes more protocol than Stela currently needs.
- **Accept raw ECharts options**: maximum renderer flexibility, but couples
  durable artifacts to a third-party runtime and admits executable callbacks or
  unsupported options.

## Consequences

- Chart JSON stores no rows, functions, transforms, or arbitrary ECharts
  options. Aggregation, bucketing, Top N, and business logic remain in SQL.
- Validation checks exact result fields, numeric/temporal values, row and
  category limits, preset/mark compatibility, shared-x layering, and strict
  unknown-property rejection.
- Shared formats cover number, compact number, percent, currency, date/time,
  duration, boolean, text, auto, and null labels in renderer and static export.
- Supporting a new visualization requires extending Stela's schema, compiler,
  validation, tests, and documentation rather than passing through runtime
  configuration.
- There is no compatibility path for the unreleased chart v1 contract.

