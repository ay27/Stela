---
type: ADR
id: "0078"
title: "Execution plans are progress bookkeeping, not an answer gate"
status: active
date: 2026-08-27
---

## Context

Supersedes [ADR-0075](0075-analysis-semantics-in-execution-plans.md) and rejects
[ADR-0077](0077-independent-planned-result-review.md).

ADR-0075 gave the execution plan authority over the answer: `finalize_analysis`
had to accept a declared analysis snapshot, bound to same-run evidence, before
the Agent was allowed to speak. ADR-0077 layered an independent semantic
reviewer and up to two append-only revision rounds on top of that gate. Both
were measured on Data Agent Bench, and neither survived measurement.

On the 91 shared cases between the pre-gate and gated runs, the gate scored 57
versus 54 valid answers (McNemar exact p ≈ 0.63). Of the 27 cases that created a
plan, 19 (70%) terminated with `planned analysis did not pass
finalize_analysis`; 11 of those 19 already held a correct answer that the gate
threw away. Relaxing the gate to provenance-only did not change the picture.

The plan itself was then measured on its own. On the same 61 questions, removing
the plan entirely moved 41 valid answers to 39 — McNemar exact p = 0.73, well
inside noise. What the gate reliably did produce was thrash: turns spent reading
`get_plan`, re-declaring snapshot fields, and repairing rejected finalization
instead of querying data, plus runs that hit the wall clock mid-repair and
returned nothing at all.

Meanwhile the plan card in the agent panel is the one thing about planning users
actually see and ask for: it is how a long run says where it currently is.

## Decision

**An execution plan is progress bookkeeping for the agent panel and carries no
authority over the answer. `finalize_analysis`, `revise_plan`, the analysis
snapshot types, and the independent result reviewer are removed. `create_plan`
and `update_plan` are write-only records that never fail a run: an unknown step
id, a step completed out of order, a missing evidence line, or an overwritten
terminal step returns a note, not an error.**

Correctness is defended where the wrong number actually enters the answer, not
at a plan checkpoint:

- A truncated `run_query` preview returns an instruction saying it cannot
  support an exact result, naming aggregation in the source query or
  `execute_python` over the full artifact as the two ways out.
- Every `execute_python` result is prefixed with each input alias's row/column
  count and column types, so shape and dtype are given rather than probed.
- The system prompt fixes the shape of a query-backed answer: conclusion, then
  material caveats, then one data-basis line, then the requested value alone on
  the last line with no Markdown emphasis and no thousands separators, ratios at
  full precision with the percentage alongside.

## Options considered

- **Plan as bookkeeping, correctness at the point of use** (chosen): keeps the
  one measured benefit (users can see run progress) and drops every mechanism
  that measured as noise or worse. Cost: nothing structurally prevents a planned
  answer from being emitted with open questions; the prompt and the truncation
  instruction are the only guardrails.
- **Keep the provenance-only gate from the first draft of this ADR**: still
  spends turns on snapshot bookkeeping and can still terminate a run holding a
  correct answer, for no measured accuracy gain.
- **Keep ADR-0077's reviewer as an opt-in flag**: leaves unmeasured machinery,
  a second prompt contract, and a revision protocol in the tree indefinitely.
  Any future semantic reviewer can be reintroduced on its own outcome evidence
  without this scaffolding.
- **Remove plans entirely**: the smallest code, and statistically
  indistinguishable on the benchmark, but it deletes the progress view that the
  agent panel depends on for long runs.

## Consequences

- `AgentPlanSnapshot` is `{ runId, version, steps }`. The analysis-semantics
  types, `revision`, and the `finalize_analysis` / `revise_plan` tools are gone
  from `electron/shared/types.ts`. Sessions that recorded them replay as plain
  step lists.
- No agent turn can be spent repairing plan state, and no run can terminate
  because a plan failed to finalize.
- Nothing deterministically blocks a truncated preview from reaching an answer.
  The truncation instruction and the answer-shape prompt are prompt-level
  defenses and will regress silently if the prompt drifts, so the benchmark's
  paired comparison is the regression detector.
- Benchmark runs hold `--salvage-ms` back from `--timeout-ms`: a run that hits
  the wall clock or a tool cap with no answer loses its tools and gets one final
  turn over the evidence it already has, reported as a `*_salvaged`
  `terminateReason`. This is benchmark-only harness behavior; the product has no
  equivalent cap.
- Re-evaluate only on paired benchmark evidence. A rise in exact-value answers
  drawn from truncated previews is the signal that would justify a deterministic
  check at the point of use — not a return of the plan gate.
