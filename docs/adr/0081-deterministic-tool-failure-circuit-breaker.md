---
type: ADR
id: "0081"
title: "Deterministic tool failure circuit breaker"
status: active
date: 2026-08-28
---

## Context

Local observability over 1703 runs (2026-08-03 to 2026-08-28) shows that failed
tool calls, not harness overhead, are the second largest source of Agent wall
time. Harness overhead is negligible: run startup to the first turn averages
50ms, inter-turn gaps 3ms, teardown 1ms. Across 42 chats with tool errors, 119
failed calls cost an estimated 42.8 of those chats' 161.8 wall minutes, because
every rejected tool result buys another full model turn (step p50 7.6s, p90
33s).

The failures cluster in tools whose payload is deterministically validated
rather than data-dependent: `update_analysis_canvas` failed 36 of 58 calls
(62%), `propose_edit` 31 of 71 (44%), `create_chart` 9 of 31 (29%). The tail is
pathological repetition of the same rejected shape: one run issued 9 consecutive
failing `propose_edit` calls, and five runs issued 4 consecutive failing
`update_analysis_canvas` calls each. When a payload is rejected by a schema or an
anchor lookup, retrying the same tool with a near-identical payload cannot
succeed, so the retries are pure latency.

[ADR-0017](0017-user-cancelled-agent-runs.md) removed
iteration and wall-clock caps and named "automatic loop detection based on
repeated tool calls" as the trigger to re-evaluate.
[ADR-0069](0069-adaptive-agent-strategy-review.md) already owns repetition in
exploration tools with a deliberately advisory ledger, because valid analyses
legitimately need many queries.

## Decision

**Block a single tool for the remainder of a run after it returns three
consecutive failures, and reset its counter on any success.** The breaker lives
in `dispatchTool`, keeps per-tool-name counters on the per-run tool context, and
exempts the exploration tools that [ADR-0069](0069-adaptive-agent-strategy-review.md)
governs. It never terminates the run.

## Options considered

- **Per-tool-name consecutive-failure breaker** (chosen): targets exactly the
  deterministic-rejection loops the traces show, leaves every other tool and the
  run itself usable, and needs one counter map per run.
- **Global tool-call cap**: predictable cost, but re-introduces the false stop
  that [ADR-0017](0017-user-cancelled-agent-runs.md)
  removed and would kill valid long analyses.
- **Terminate the run on repeated failure**: removes the wasted turns outright,
  but contradicts user-cancelled runs and throws away recoverable work when only
  one tool is broken.
- **Extend the ADR-0069 ledger to all tools**: reuses existing machinery, but the
  ledger is advisory by design and its query-family normalization is meaningless
  for Canvas and note-edit payloads.
- **Prompt-only instruction not to retry**: no code, but the observed 9-call
  streak happened while the failing tool result already said what was wrong.

## Consequences

- The blocked-tool message is directive: stop calling it, reach the goal another
  way, or answer with the evidence already gathered and state what is missing.
- Exploration tools (`list_databases`, `list_tables`, `search_tables`,
  `get_table_schema`, `run_query`, `run_sql`, `execute_python`) are never
  blocked, so `DATA_ANALYSIS_TOOLS` is now exported from
  `analysis-efficiency.ts` as the single source of that boundary.
- User rejections count as failures, so three consecutive rejected proposals
  block that proposal tool. That is intended: repeatedly re-proposing after a
  rejection is the same wasted turn.
- A genuinely recoverable tool can be blocked after three unlucky failures
  within one run; the model must then switch approach instead of converging by
  retry. The counter is per run, so the next run starts clean.
- The breaker measures repetition, not correctness. It is a backstop behind the
  real fix of making tool schemas and error messages actionable, not a substitute
  for it.
- Re-evaluate if traces show tools blocked while still converging, if three
  proves too tight for proposal tools under normal review friction, or if a
  future executing subagent needs its own failure budget.
