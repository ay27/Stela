---
type: ADR
id: "0068"
title: "Headless Pyodide Agent evaluation"
status: active
date: 2026-08-17
---

## Context

[ADR-0064](0064-session-query-artifacts-and-sandboxed-python.md) gives the
desktop Agent a browser Web Worker running offline Pyodide, DuckDB, and pandas.
The Linux DataAgentBench runner previously hid `execute_python` because it had
no renderer. As a result, benchmark failures reported a missing capability even
though the shipped product could perform the cross-connection computation.
Using system Python would measure a different and less secure product.

## Decision

**Headless Agent evaluation runs the same extracted Pyodide execution core and
offline dependency closure in isolated Node workers, while preserving the
product tool schema, session artifact authorization, and bounded I/O rules.**

The Node adapter is evaluation-only. It supplies an empty JavaScript global
object, mounts no host filesystem, streams only authorized artifact bytes into
Pyodide's in-memory filesystem, disables network/package installation, and
enforces the product timeout and result limits. A bounded worker pool represents
independent benchmark app sessions without changing the model-facing tool.

## Options considered

- **Shared Pyodide core with an evaluation adapter** (chosen): measures the same
  compute semantics without adding a benchmark-only model tool or system
  dependency.
- **Run system Python/pandas**: easy on DataAgentBench hosts, but not the product
  runtime or its security boundary.
- **Launch the full Electron renderer under Xvfb**: closest process topology,
  but adds display-server dependencies and substantial orchestration noise.
- **Continue hiding `execute_python`**: reproducible, but systematically
  under-measures Stela's cross-connection capability.

## Consequences

- The renderer worker and headless worker import one execution script and result
  normalizer, with parity fixtures covering DuckDB, pandas, errors, and limits.
- DAB query results create disposable session artifacts and expose the existing
  `execute_python` tool only when offline Pyodide assets pass preflight.
- Headless workers may consume significant memory, so evaluation concurrency is
  separately bounded and recorded in the manifest.
- This does not authorize Node-hosted Python in the desktop product; the shipped
  application remains on the Node-free browser Web Worker from ADR-0064.
- Re-evaluate if Pyodide gains a single environment-neutral Worker adapter or if
  DAB provides a product-runtime integration protocol.
