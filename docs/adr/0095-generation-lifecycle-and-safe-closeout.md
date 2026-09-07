---
type: ADR
id: "0095"
title: "Generation lifecycle and evidence-only closeout"
status: active
date: 2026-09-07
---

## Context

Supersedes [ADR-0092](0092-bounded-generation-recovery.md). A default 180-second
generation deadline terminated eleven failed-subset DAB cases, including all eight
CVE cases. First-delta telemetry cannot distinguish active reasoning from a stall.
DAB-only salvage also erased the originating failure when prose was produced.

## Decision

**Keep generation-boundary retries, but separate opt-in response/first-delta/idle/
total deadlines from caller cancellation and task deadlines. Share a single bounded,
tool-free evidence closeout between desktop and DAB without erasing execution failure.**

No default generation deadline replaces the caller's task lifetime. Opt-in idle
timeouts count thinking, text and tool-argument deltas, not HTTP heartbeats.
Attempts remain bounded; the retry window starts only after the first transient
failure. User cancellation, refusal, authentication and quota failures never start
closeout. Closeout requires committed query/Python evidence and available time,
makes at most one provider request, dispatches no tools, and cannot claim completion.

## Options considered

- **Shared lifecycle policy** (chosen): same semantics, independent caller deadlines.
- Increase the fixed three-minute ceiling: hides rather than defines the boundary.
- Re-prompt the full harness: risks tools, loops and failure-state ambiguity.

## Consequences

Uncalibrated first-delta/idle limits remain disabled by default; desktop users can
cancel and DAB still enforces its task deadline. Diagnostic delta timings are needed
before enabling tighter provider policies. Partial or absent usage is not zero cost.
Committed tool history is unchanged and failed tools are never replayed. Closeout
adds at most one request and may still fail; both errors remain observable.
ADR-0094 preview isolation remains unchanged. No new dependency or artifact store.
