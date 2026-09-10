---
type: ADR
id: "0097"
title: "Semantic input reduction and bounded cost probing"
status: active
date: 2026-09-10
---

## Context

ADR-0091 bounds individual operations but a successful preflight does not establish
that the token budget can finish a large input. Duplicate records can consume
inference repeatedly within a batch, and partial operations can be mistaken for
complete task populations.

## Decision

**Behind an independent opt-in experiment, reduce classify/extract inputs by exact
selected-content equality, preserve original row mappings, and extend existing
preflight with input scale and one bounded real-work cost probe.**

Keep deterministic filtering/parsing in SQL/Python. Never interpret unmatched text
as a negative label. Preserve types, case, digits and selected context. Resolve
candidate construction is unchanged. Existing run-scoped cache and resume remain
the only reuse mechanisms; no persistent cache, new provider or model tier.

Reject known record/request deficits without inference. An uncertain large operation
may use one batch of at most eight rows, one inference attempt and at most 10% of
the remaining token reservation. Retain its actual results. Forecast remaining
reservation-weighted usage with a 1.5 conservative factor; unknown usage or an
over-budget forecast stops further scheduling. Forecasts are estimates, not
completion promises or currency prices. Actual execution retains host budget checks.

## Options considered

- **Existing helpers, host ledger and typed RPC** (chosen): shared desktop/headless behavior.
- Whole-dataset inference: unpredictable cost and partial-task failure.
- Model cascade or persistent classifier: requires separate quality calibration.

## Consequences

Inference counts refer to unique submitted records; coverage refers to original
rows. Probe results never authorize statistical estimation. Retries, cancellations
and unknown usage remain charged conservatively. An explicit partial-processing
choice is still not permission to extrapolate an answer. The experiment defaults
off until paired evaluation; ADR-0091's authority and resume rules remain in force.
