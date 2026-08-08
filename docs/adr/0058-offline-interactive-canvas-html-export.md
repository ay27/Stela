---
type: ADR
id: "0058"
title: "Offline interactive Canvas HTML export"
status: active
date: 2026-08-08
---

## Context

Analysis Canvas HTML export originally replaced each ECharts view with an SVG
snapshot. The file was portable, but it lost tooltips, legend interaction,
hover emphasis, responsive resizing, and some runtime rendering details. A CDN
could restore those capabilities with a small file, but exported analysis must
remain usable offline and must not depend on a mutable third-party URL.

## Decision

**Export Canvas charts as offline interactive ECharts views by embedding the
minified application-pinned ECharts runtime, current audited result data, and
Stela-compiled options in the single HTML file.** The export contains no Stela
IPC, connector access, network request, or arbitrary chart code from the Canvas
artifact; tables and Flow diagrams remain frozen snapshots.

## Options considered

- **Embed the pinned ECharts runtime** (chosen): preserves interaction and
  single-file offline portability, at the cost of roughly 1.1 MB per exported
  document containing charts.
- **Load ECharts from a CDN**: keeps files small, but requires network access,
  weakens reproducibility, and adds a remote script trust dependency.
- **Keep SVG snapshots**: smallest and safest runtime surface, but loses the
  exploratory behavior users expect from the Canvas.
- **Export an HTML file plus asset directory**: avoids repeating the runtime,
  but makes sharing, moving, and revealing the export less reliable.

## Consequences

- Export loads the raw runtime only on demand; normal Canvas rendering and app
  startup do not include the extra module in their initial path.
- Each file freezes the ECharts version, compiled option, formatter metadata,
  and result snapshot that existed at export time, so it remains reproducible
  without access to the Vault or execution store.
- The exported document executes embedded JavaScript. Script-boundary escaping
  is mandatory, and the exporter must continue compiling the strict Stela chart
  grammar rather than serializing model-authored callbacks or raw ECharts
  options.
- Export tests must cover option serialization and callback rehydration so
  tooltip and axis formatting do not silently degrade.
