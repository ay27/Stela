---
type: ADR
id: "0077"
title: "Independent planned-result review and bounded revision"
status: rejected
rejected_by: "0078"
date: 2026-08-26
---

> **Rejected by [ADR-0078](0078-plans-as-progress-bookkeeping.md).**
> The reviewer only ran on candidates that had already passed the ADR-0075 gate
> — 8 of 27 planned benchmark cases — so its ceiling was small while it added at
> least one model call and up to two revision rounds to the slowest tasks. The
> gate it depended on measured as noise and was removed, and the reviewer,
> `revise_plan`, the revision cap, and the warning fallbacks were removed with
> it. The record below is kept for the reasoning, not as a live contract.

## Context

ADR-0075 prevents a planned analysis from emitting an answer without a current
plan, terminal steps, and same-run evidence. That structural contract cannot
decide whether the Agent chose the right analytical direction, denominator,
grain, filter, or interpretation. It also left no legal transition for
correcting a semantically weak candidate after every original step had become
terminal: completed steps could not be reopened, while a new plan could not be
created. Repeated `update_plan` and `finalize_analysis` calls therefore produced
deterministic errors without changing evidence.

## Decision

**Keep structural evidence finalization as a mandatory deterministic gate, then
run one isolated, tool-free semantic reviewer for every planned result. When the
reviewer requests correction, append immutable remediation steps for at most two
revision rounds; after two unsuccessful revisions, emit the reviewer-selected
structurally valid candidate with a visible warning.**

The reviewer uses the active profile's model and effective reasoning effort but
receives a separate bounded context containing the question, current plan,
candidate, declared checks, and bounded summaries of bound same-run evidence.
It never receives tools. Its structured result either accepts the candidate or
names invalid assumptions, evidence gaps, evidence to preserve, concrete next
steps, and a success condition.

`update_plan` may replace the full analysis snapshot after steps are terminal.
`revise_plan` is reviewer-authorized, preserves completed history, and appends
one to three remediation steps. Plan snapshots record a revision count capped
at two. Structural failures never use the warning fallback. A reviewer transport
or response-contract failure gets one format-repair attempt; if review remains
unavailable, Stela emits the structurally valid candidate with a distinct
review-unavailable warning.

## Options considered

- **Deterministic gate plus isolated semantic review and bounded append-only revision** (chosen): preserves auditable evidence and permits correction without rewriting history, at the cost of one or more additional model calls for planned tasks.
- **Extend `finalize_analysis` to judge semantics itself**: combines deterministic and probabilistic outcomes, making tool failures and remediation ambiguous.
- **Reopen completed steps or replace the whole plan**: simplifies retry prompts but destroys the immutable record of what produced each candidate.
- **Reject every candidate the reviewer does not accept**: maximizes strictness but can discard useful evidence-backed work after reviewer disagreement or exhaustion.

## Consequences

- Simple no-plan questions keep the existing latency and skip semantic review.
- Planned tasks pay at least one additional model call, counted in normal usage
  and observability.
- Every semantic correction changes the plan version, appends steps, and must
  pass fresh structural evidence finalization before another review.
- The two-revision bound prevents unbounded reviewer/Agent loops. Warning output
  remains evidence-backed but explicitly communicates unresolved semantic risk.
- The reviewer sees bounded values rather than full artifacts. Exact large-data
  conclusions must therefore be represented by non-truncated aggregate or
  Python evidence before finalization.
- Re-evaluate the bound or reviewer model policy only with outcome-based
  benchmark evidence; generic automatic tool retries are not part of this
  decision.
