---
type: ADR
id: "0055"
title: "Vault analysis Canvas artifacts"
status: active
date: 2026-08-06
---

## Context

Supersedes [ADR-0054](0054-runsql-owned-analytical-charts.md).

Charts are presentation and exploration output, not part of a data note's
semantic SQL narrative. Attaching them to RunSQL details made Markdown parsing,
execution history, and export more complex while adding little beside an already
clear result table. Conversely, a long analysis needs a durable place for
several queries, conclusions, KPIs, tables, and charts without turning an Agent
conversation into the only record.

## Decision

**Store multi-view analytical presentations as ordinary, Git-trackable
`*.stela.canvas` JSON files in the Vault, separate from Markdown, and keep
single-result charts ephemeral in the Agent timeline.**

A Canvas embeds versioned read-only SQL sources and structured
`markdown | kpi | chart | table` cards. Cards reference source ids; each source
records its latest audited run id instead of embedding result rows. The Canvas
workspace is read-only: the Agent creates or updates its structure, while users
may refresh one source or all sources from the UI. Refresh is explicit and
snapshot-based; a failed refresh records the error and retains the prior
successful snapshot.

## Options considered

- **Separate Vault Canvas artifact** (chosen): gives complex analyses a focused,
  durable presentation surface while keeping notes and execution blocks simple.
- **Charts inside RunSQL details**: keeps the visualization near its query, but
  couples presentation state to Markdown parsing, history browsing, and export.
- **Conversation-only charts**: has the smallest storage model, but long analyses
  are difficult to revisit, compare, export, or review in Git.
- **Editable dashboard builder**: offers direct manipulation, but introduces a
  second authoring system before Agent-generated Canvas behavior is proven.

## Consequences

- Markdown `<detail>` contains execution metadata only. Note export no longer
  needs chart assets or a bundle-writing IPC.
- Canvas writes use a strict versioned Zod schema, Vault path validation, atomic
  writes, and etag conflict detection. There is no migration from the unreleased
  ADR-0053/0054 formats.
- New or changed Agent SQL sources must bind to a successful query from the same
  Agent run; Stela copies audited SQL and connection metadata rather than trusting
  model-authored source fields.
- Canvas query results remain in the existing SQLite/JSONL execution stores. The
  source file contains only source definitions, card layout, and run references.
- Static HTML export freezes the current result-backed SVGs and tables and
  includes collapsed SQL source text, with no executable bridge.
- A future editable Canvas would require a new decision covering authorship,
  merge semantics, and direct-manipulation contracts.
