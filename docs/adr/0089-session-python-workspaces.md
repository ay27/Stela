---
type: ADR
id: "0089"
title: "Session Python analysis workspaces"
status: active
date: 2026-09-05
---

## Context

Supersedes [ADR-0086](0086-declarative-query-sources-for-python.md).
Fresh interpreters require repeated source reads and reconstruction of intermediate results.

## Decision

**Retain one isolated, disposable Python workspace per Vault and Agent session,
while preserving declarative read-only sources and the existing internal data transport.**

Omitted sources reuse snapshots; redeclared aliases refresh, without updating
previously computed DataFrames. A reset clears the namespace and cached work.
Ordinary Python exceptions may leave partial mutations. Fatal errors, cancellation,
eviction and application shutdown destroy state; loss is reported, never silently replayed.
Result JSON is bounded structurally, not sliced after serialization.

## Options considered

- **Session workspaces** (chosen): reusable computations with explicit lifetime and loss.
- Stateless programs: simple isolation, but repeated I/O and recovery costs.
- Persisted notebooks/checkpoints: stronger recovery, but serialization, security and storage complexity.

## Consequences

Workers and lazy relation input files must remain owned by their workspace.
Desktop retention is bounded; headless cases must retain their worker lease until
case completion. Cached data can become stale and must expose snapshot metadata.
No Python object persistence, generic filesystem bridge or model-managed artifacts.
