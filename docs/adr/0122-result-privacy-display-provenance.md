---
type: ADR
id: "0122"
title: "Source-scoped privacy annotations for result tables"
status: active
date: 2026-09-26
---

## Context

Raw result tables are shared by Chat and RunSQL and deliberately show local
originals. Text replacement annotations cannot establish which result column
was masked, especially after partial release or when values repeat across sources.

## Decision

**Main attaches optional result-display metadata to tool-result privacy events,
bound to result run ID and column ordinal.** It compares the local source preview
with the prepared model projection and records masked, partial or released
columns without copying original values into this metadata. Chat reduces these
observations in event order and passes only the matching run's metadata to the
shared BlockResult/ResultTable components. Headers underline masked/partial
columns, with distinct explanations; released columns are not shown as protected.

Observations describe the prepared tool preview, not proof that every stored row
was transmitted. A direct SQL execution without model preparation has no marker.
Legacy events without metadata remain unmarked rather than guessing from values.
Paging and history selection cannot copy annotations to another run. The shared
table continues to display and export originals locally. Metadata is presentation
only, never an authorization grant or model input.

## Options considered

- **Host result/column evidence (chosen):** preserves source boundaries and
  distinguishes selective release; introduces optional event metadata.
- Match displayed values against a token map: mislabels repeated values and
  cannot distinguish permissions for separate result columns.
- Reclassify rows in the renderer: duplicates policy and claims masking that
  may never have occurred.

## Consequences

New observations survive Chat persistence; historical results without evidence
remain unmarked. JSON/mixed columns can only claim partial masking at header
level. RunSQL and Chat share compact controls, paging and export behavior while
Chat additionally offers SQL disclosure because its query editor is not inline.
