---
type: ADR
id: "0093"
title: "Evidence-backed Python answer contracts"
status: active
date: 2026-09-06
---

## Context

Successful SQL and semantic rows can still use the wrong population, denominator,
business rule or output granularity.

## Decision

**Provide a small optional answer contract in the Python workspace: sourced claims,
explicit unknowns and deterministic coverage checks, without another model reviewer
or a mandatory tool round-trip.** Agent guidance uses it for material semantic risks.

## Options considered

- **Local evidence contract** (chosen): inspectable assumptions and checks.
- Universal final-answer reviewer: added cost and uncalibrated authority.
- Free-form confidence: conflates evidence, completeness and correctness.

## Consequences

Checks validate supplied observations, not the truth of model-authored assertions.
The contract cannot claim global coverage from a filtered sample. No persistence
beyond the workspace or replacement of existing plan/finalization authority.
