---
type: ADR
id: "0091"
title: "Preflight and resumable semantic operations"
status: active
date: 2026-09-06
---

## Context

Extends [ADR-0090](0090-bounded-semantic-execution.md). Real batch tasks can exceed
the entire run budget, repeat empty RPCs, or aggregate partial results as complete.

## Decision

**Preflight semantic operations against host-owned budgets, stop scheduling on
exhaustion, and retain explicit resumable results bound to their input and definition
in the existing disposable Python workspace.** Full coverage is the default intent;
explicit partial execution is not statistical sampling or permission to estimate.

## Options considered

- **Bounded workspace operations** (chosen): reuse existing authority and lifetime.
- Unlimited inference: unacceptable spending and disclosure.
- Persistent artifacts/checkpoint service: duplicates the workspace data path.

## Consequences

Preflight is conservative and cannot guarantee future token cost or reserve a whole
operation against concurrent work. Execution remains authoritative and race-safe.
Cache checks are bounded; large cached operations should reuse their retained result.
Resume requires the same full input, definition and row mapping; changed inputs fail
closed. Required input fields are explicit, not inferred from prose. Completeness and
schema validity do not establish semantic correctness. No new dependency or artifact.
