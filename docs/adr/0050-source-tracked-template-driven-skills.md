---
type: ADR
id: "0050"
title: "Source-tracked template-driven Skills"
status: active
date: 2026-08-03
---

## Context

Supersedes [ADR-0045](0045-recency-ordered-skill-distillation.md).

Recency ordering helps initial distillation but Skills do not retain which notes
support them, so later document changes cannot invalidate retained guidance. The
maintenance prompt also asks the model to retrieve, rank, reconcile, classify,
and write knowledge, producing slow multi-turn runs and overusing the broad
analysis-runbook category.

## Decision

**Record supporting Vault-note hashes and table retrieval anchors in each
automatically maintained Skill, refresh stale Skills before use, and move
retrieval and validation into deterministic services. The maintenance model gets
the complete current-task conversation plus at most three bounded source notes
and fills one category-specific template or performs no write.** Automatic
creation is limited to dialect, metric, glossary, and lineage knowledge;
analysis-runbooks require an explicit user request.

## Options considered

- **Source-tracked template distillation** (chosen): retains rich context while
  making provenance and refresh deterministic.
- **Short prompt with evidence summaries only**: fast but can omit the user
  meaning needed to form correct reusable knowledge.
- **Unstructured full-context maintenance**: complete but leaves retrieval,
  classification, and lifecycle decisions to the model.

## Consequences

- Source-backed Skills can be invalidated by content changes or newer related
  documents without a new persistent index.
- Existing source-less Skills need bounded recovery before trusted reuse.
- Templates improve consistency but intentionally reject knowledge that does not
  fit a supported durable category.
- Full task context increases one request's input size; deterministic retrieval
  and a single write tool remove most follow-up turns.
