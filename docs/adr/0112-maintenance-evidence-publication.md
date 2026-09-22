---
type: ADR
id: "0112"
title: "Independent evidence for automatic knowledge publication"
status: active
date: 2026-09-18
---

## Context

A generated analysis note can feed maintenance and become apparently independent support for its own unsupported business assumptions. File hashes establish identity, not truth.

## Decision

Track current-run generated notes separately and exclude them from independent maintenance sources. Automatic publication must carry bounded structured evidence; unsupported candidates remain diagnostics rather than automatically loaded knowledge. Comparison contracts explicitly distinguish a population definition from evidence relating its stages. Deterministic checks validate provenance and observable facts, not arbitrary business prose.

## Options considered

- **Bounded provenance checks (chosen):** no extra model calls, conservative publication.
- Larger maintenance model or prompt alone: cannot establish source independence.
- General semantic verifier: expensive and still unable to prove business truth.

## Consequences

More candidates may remain unpublished. Existing Skills are preserved on rejection. Existing maintenance budgets stay unchanged. Historical snapshots without these fields remain unknown; no automatic Vault migration or cleanup is performed.
