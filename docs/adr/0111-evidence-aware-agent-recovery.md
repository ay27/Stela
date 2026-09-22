---
type: ADR
id: "0111"
title: "Evidence-aware Agent recovery and delivery"
status: active
date: 2026-09-18
---

## Context

A continuation could see an old plan in conversation text while its runtime store was empty. File persistence and runtime completion did not establish that all requested outputs existed. Canvas authoring failures consumed the same retry allowance as execution failures.

## Decision

Restore only the latest unfinished plan on the current session branch, preserving origin and evidence without replaying tools. Require explicit replacement for a new task. Optional declared file deliveries receive host-written receipts only after successful writes; receipts establish persistence, never analytical truth. Separate bounded validation repair from execution failure accounting, including schema failures rejected by the harness.

## Options considered

- **Session snapshots and host receipts (chosen):** reuse existing storage and UI; legacy undeclared outputs remain unknown.
- Infer completion or continuation from prose: ambiguous and cannot prove persistence.
- Gate all final answers on plans: incompatible with lightweight analyses and observational plans.

## Consequences

No new dependency or IPC capability. Model step completion cannot manufacture a saved file. Restoring a plan does not execute or approve anything. Declared outputs are necessary to measure completeness; unmentioned requirements cannot be inferred reliably. Saved content can still be analytically incorrect.
