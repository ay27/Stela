---
type: ADR
id: "0092"
title: "Bounded model generation recovery"
status: superseded
superseded_by: "0095"
date: 2026-09-06
---

## Context

Model streams can fail after successful tools. Restarting a task risks duplicate
actions; the installed harness exposes provider streams but no public continue API.

## Decision

**Recover transient failures at the model-stream boundary, before tools are
dispatched, with bounded attempts and sanitized diagnostics shared by desktop and
DAB.** Never retry cancellation, safety refusal or arbitrary application errors.

## Options considered

- **Generation-boundary recovery** (chosen): tool journal and workspace untouched.
- Reprompt the entire task: duplicate actions and partial-message ambiguity.
- Evaluation-only salvage: diverges from the product.

## Consequences

Attempt output is buffered until a successful generation; this delays live text for
that request but prevents failed tool calls and partial text leaking into the loop.
Provider-level retries are disabled on this path to avoid multiplicative retries.
Attempts share cancellation and a bounded request deadline. Unknown errors remain
visible; an opaque terminated error is not proof of a particular network cause.
