---
type: ADR
id: "0075"
title: "Analysis semantics and current-run evidence finalization"
status: superseded
superseded_by: "0078"
date: 2026-08-24
---

## Context

Stela's execution plan records ordered actions and completion evidence, but it
does not state the analytical contract that those actions are meant to satisfy.
For multi-source or multi-stage work, an Agent can therefore finish the planned
steps while silently changing grain, measure, filters, joins, or expected output
between discovery and reporting. A separate precomputed evidence catalog would
add startup scanning, another storage authority, freshness rules, and work even
for simple questions that do not need it.

## Decision

**Extend the existing immutable `AgentPlanSnapshot` with optional structured
analysis semantics, and require planned analyses to pass a same-run evidence
finalization tool before their answer is emitted. Do not add offline scanning,
a precomputed evidence catalog, or an evidence database.**

`create_plan` may begin with the question, known constraints, and unresolved
items. After live schema and business discovery, `update_plan` replaces the
complete current analysis snapshot: question, grain, measure, dimensions,
filters, sources and columns, joins, output shape, assumptions, unresolved
items, and verification checks. The plan remains versioned and append-only in
the pi session.

Successful `run_query` and `execute_python` calls register bounded evidence
metadata only in the current Agent runtime. `finalize_analysis` accepts the
current plan version, exact evidence run ids and fields, and run ids for every
declared verification check. It rejects incomplete or stale plans, unfinished
steps, unresolved items, missing same-run evidence, direct truncated previews,
unknown fields, missing checks, and evidence that cannot trace back to the
declared sources. A planned run gets one continuation opportunity to repair a
missing finalization; it does not emit a normal final answer if the gate still
has not passed. Tasks that never create a plan remain on the existing fast path.

## Options considered

- **Analysis semantics in the existing plan plus a same-run gate** (chosen):
  keeps intent, execution, and evidence in one versioned object and spends work
  only when task complexity already warrants a plan.
- **Separate evidence-contract object**: makes the contract independently
  addressable, but creates a second lifecycle and synchronization problem beside
  the plan without improving the current product flow.
- **Pre-scan the user's data into DuckDB or another evidence store**: can make
  retrieval cheap after indexing, but introduces preprocessing, freshness, and
  storage-authority costs before Stela knows which uncertainty matters.
- **Prompt-only planning discipline**: has no deterministic check that the final
  answer still matches the resolved grain, sources, fields, and verification
  work.

## Consequences

- Complex analyses expose their semantic decisions in immutable plan history,
  so compaction and later turns retain more than a list of actions.
- Final answer evidence must come from successful query or Python outputs in the
  same Agent run; stale plan versions and copied run ids are rejected.
- The evidence registry is disposable process memory. It is neither a fifth
  storage authority nor durable reusable knowledge.
- Query preview truncation cannot support a direct final claim. Full artifacts
  may still feed bounded Python, whose own result becomes the final evidence.
- Simple single-table lookups keep their existing latency and tool behavior.
- The contract improves structural correctness but cannot decide a genuinely
  ambiguous business predicate; the Agent must resolve it from live evidence,
  ask the user, or keep the item unresolved and decline finalization.
