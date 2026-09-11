---
type: ADR
id: "0099"
title: "Reusable analysis operation evidence"
status: active
date: 2026-09-11
---

## Context

ADR-0098 observations cannot currently connect operations performed before a
population binding. Mutable result previews and unknown coverage also obscure the
difference between completed work and verified coverage of a declared population.

## Decision

**Keep run-local operation evidence independently of public result rows and
summaries, and expose contract.observe(batch) to verify it against a frozen source
binding without new inference. Separate operation counts from population coverage.**

Use a weak result-object registry, typed IDs and per-cell value fingerprints, not
copies of input text. Retain fingerprints for at most 100,000 rows and 1,000,000
cells per result; larger operations retain counts with an explicit verification
limit. Bindings support an explicit source ID column without value normalization.
Current run, generation, failure epoch, source version and row content must match.
Never union separate operations or certify business meaning. This is bookkeeping
within the Python sandbox, not protection against adversarial Python introspection.

## Options considered

- **Internal execution records** (chosen): late binding is verifiable without inference.
- Trust mutable rows, summaries or DataFrame attrs: can misstate observed coverage.
- Require binding before every operation: discards otherwise usable evidence.

## Consequences

Extends ADR-0098 without introducing an answer gate. Optional snapshot fields keep
old history readable. Unknown coverage includes a reason; SQL-only work need not
have semantic coverage. Failed cells invalidate older operation evidence until a
new operation is observed. Source refresh requires a revised binding. There is a
bounded per-result memory/CPU cost for hashing; registry entries disappear when
results are released or the workspace is reset.
