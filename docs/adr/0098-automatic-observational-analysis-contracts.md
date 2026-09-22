---
type: ADR
id: "0098"
title: "Automatic observational analysis contracts"
status: active
date: 2026-09-10
---

## Context

The optional API in ADR-0093 was never invoked in the latest 55-case DAB rerun.
Source facts and known partial semantic operations must remain visible even when
the model does not create or print a contract.

## Decision

**Behind an independent opt-in experiment, register contracts automatically and
return their bounded snapshots alongside existing query/Python results. Separate
model-authored meaning and checks from host-observed source/execution facts.**

Expose `analysis.current`, retain `analysis.contract(required=...)`, and register
explicit contracts automatically. Allow binding a population by stable row IDs and
source reference; later subset operations do not redefine that population. A
source reference is only corroborated when it resolves to current source evidence
or a quoted user request. This does not certify the interpretation of that evidence.

Collect SQL-only evidence without starting Python. Capture Python snapshots on
success and ordinary exceptions. Unknown lineage, refreshed inputs and lost
workspaces cannot certify current task coverage. Display missing claims, failed
checks and partial/unknown operation coverage without preventing answers, adding
a reviewer, or repeatedly asking the model to satisfy a completion gate.

## Options considered

- **Automatic observational snapshots** (chosen): evidence survives absent API adoption.
- Prompt-only optional contracts: already showed zero adoption.
- Mandatory final-answer gate: risks loops and uncalibrated authority.

## Consequences

Extends shared result DTOs and existing result/history rendering, not a new artifact
service. Arbitrary DataFrame lineage and business truth are not inferred. Contract
creation is not an accuracy metric. Existing APIs remain compatible; the experiment
defaults off for controlled comparison. Supersedes ADR-0093's optional-only entry
point, retaining its distinction between checks and business correctness.
