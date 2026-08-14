---
type: ADR
id: "0064"
title: "Session query artifacts and sandboxed Python"
status: active
date: 2026-08-14
---

## Context

Agent `run_sql` currently returns and records only the rows left after the core
`execution.maxRows` cap. That is enough for timeline previews and charts, but it
cannot support exact cross-connection joins or Python analysis over a large
result. Persisting every row in the Git-synced JSONL journal would make normal
history unusable, while passing arbitrary host paths to model-authored Python
would break the Electron security boundary.

The connector v1 contract also returns one in-memory `unknown[][]`; writing that
array to a temporary file after the call does not make the database fetch
streaming. Existing plugins must continue to work, but large-result support must
not be claimed unless the connector can materialize incrementally.

## Decision

**Agent SQL produces a bounded audited preview plus a machine-local,
session-scoped query artifact addressed only by run id. `execute_python` runs in
a Node-free Pyodide Web Worker with DuckDB and pandas, and receives only
explicitly selected artifacts. Connector API v2 may materialize read-only query
results directly to Parquet; v1 connectors use a bounded buffered fallback.**

- Artifacts are disposable local cache under Electron `userData`; they are not
  written to Vault JSONL, SQLite result rows, Markdown, or Git.
- Tool output never contains an artifact path. The main process resolves a
  same-session run id and streams authorized bytes to the renderer runtime.
- Pyodide assets and the exact DuckDB/pandas dependency closure ship with the
  application. Runtime package downloads and general network access are denied.
- Production CSP permits `wasm-unsafe-eval` for WebAssembly compilation while
  retaining self-only scripts and connections; ordinary `unsafe-eval` remains
  disabled outside development.
- Schema and SQL tools may select a named Vault connection without exposing its
  configuration or credentials. The current note connection remains the
  default.
- Python output is bounded Agent timeline evidence in v1. It does not become a
  Canvas/chart source or a new durable RunSQL history kind.

## Options considered

- **Session artifact + Pyodide** (chosen): one model-visible compute tool,
  browser-compatible isolation, exact cross-connection analysis, and bounded
  Git history; adds a local cache and a renderer runtime broker.
- **Store all rows in existing SQLite/JSONL**: reuses result loading, but makes
  Git history and rebuilds grow with analytical datasets. Rejected.
- **Independent DuckDB-Wasm transform tool**: efficient relational execution,
  but overlaps with Python and gives the model two similar compute tools.
  Rejected.
- **System Python or Node-hosted Pyodide**: avoids renderer IPC, but depends on
  user setup or exposes Node globals; neither is an acceptable sandbox.

## Consequences

- Connector v1 stays compatible, but only v2 materialization can truthfully
  guarantee bounded-memory database extraction. Buffered fallback artifacts
  are explicitly marked and size-limited.
- Cross-device Agent history can still show an old run while its local artifact
  is absent. A later computation must rerun that SQL instead of silently using
  preview rows.
- The application package grows because Pyodide, DuckDB, pandas, NumPy, and
  their pinned wheels are bundled locally.
- The renderer runtime is app-owned rather than panel-owned, so panel mounting
  and focus cannot affect an active computation.
- Re-evaluate if browser/Wasm memory limits block common workloads, if durable
  computed datasets become a product requirement, or if connectors converge on
  a host-owned Arrow streaming contract.
