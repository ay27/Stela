---
type: ADR
id: "0021"
title: "Parallel agent tools except propose_edit"
status: active
date: 2026-07-16
---

## Context

Supersedes [ADR-0020](0020-parallel-readonly-agent-tools.md).

ADR-0020 kept `run_sql` sequential alongside `propose_edit`. In practice `run_sql` is read-only by default (`sql-guard`); mutations are blocked unless `agentAllowMutations` is on, and even then they wait on proposal. Static `executionMode` cannot distinguish SELECT from INSERT per call, but the common path is concurrent SELECTs mixed with schema/vault lookups. Subprocess connectors already mutex contended DB work.

## Decision

**Mark all agent tools `executionMode: "parallel"` except `propose_edit`, which stays `sequential`.** `run_sql` relies on sql-guard + proposal for write safety, not on sequential tool execution. Future tools: parallel unless they always block on note-edit (or similar) proposal UX that should not race.

## Options considered

- **Keep `run_sql` sequential** (ADR-0020): avoids concurrent mutation proposals when mutations are enabled; serializes independent SELECTs. Rejected — default mutations off, proposal map already keys by `callId`.
- **`run_sql` parallel / only `propose_edit` sequential** (chosen): maximizes same-turn fan-out for the read path; note-edit proposals stay ordered when mixed into a batch (pi: any sequential tool forces the batch sequential).
- **All parallel including `propose_edit`**: possible, but concurrent note diffs are worse UX than concurrent SQL proposals. Deferred.

## Consequences

- Same-turn batches without `propose_edit` can run concurrently (including multiple `run_sql`)
- A batch that includes `propose_edit` runs entirely sequentially
- With mutations enabled, multiple mutation proposals may wait in parallel (rare; UI already tracks multiple `callId`s)
- Subprocess connectors may still serialize under their internal lock
- Still not multi-agent / subagent orchestration
