---
type: ADR
id: "0069"
title: "Adaptive Agent strategy review"
status: active
date: 2026-08-17
---

## Context

DataAgentBench traces show that slow Agent runs rarely repeat an identical tool
call. They keep one strategy while changing ids, literals, offsets, or small
parts of a query: successful cases averaged 33.4 tool calls and 5.9 minutes,
failed cases averaged 43.9 calls and 12 minutes, and one failed case issued 147
`run_query` calls. A low global call cap would also stop valid long analyses.

## Decision

**Track a bounded per-run data-analysis ledger and request at most one tool-free
strategy review from the active Agent model when structural query fan-out,
query churn, or clustered failures indicate a stall.** The review is advisory:
Stela does not block later tools or terminate the main Agent.

The stable reviewer prompt receives only the bounded goal, current plan,
connection capabilities, counters, and twelve recent redacted observations.
Its validated response is appended as an immutable Session checkpoint and
recorded as a child observability run. The reviewer has no tools and cannot
answer the user's data question.

## Options considered

- **Adaptive ledger plus one reviewer** (chosen): targets semantic repetition
  without imposing a correctness-reducing global cap; adds one model request
  only to stalled runs.
- **Hard tool-call limit**: predictable cost, but existing valid benchmark cases
  require many calls and would be terminated.
- **Full executing subagent**: can investigate independently, but duplicates
  tools, credentials, artifacts, proposals, and mutable run state.
- **Prompt-only self-reflection**: simple, but the same model can continue the
  same strategy and compaction can lose the relevant failed-attempt history.

## Consequences

- SQL and MongoDB query-family normalization is intentionally conservative and
  is used only for hints and review triggers, never authorization or blocking.
- Review failures, invalid JSON, and cancellation leave the main run usable.
- Reviewer usage counts toward the root run and appears separately in the local
  Dashboard and DataAgentBench results.
- Session context gains at most one small checkpoint per user run; stable prompt
  prefixes remain unchanged across dynamic review inputs.
- Re-evaluate if reviewers fail to reduce tail tool calls, lower benchmark
  validity, or if a future executing subagent needs its own trust model.
