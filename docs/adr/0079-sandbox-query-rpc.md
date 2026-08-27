---
type: ADR
id: "0079"
title: "Sandbox query() RPC instead of model-managed artifacts"
status: active
date: 2026-08-27
---

## Context

Supersedes [ADR-0064](0064-session-query-artifacts-and-sandboxed-python.md).

ADR-0064 gave the sandbox its data through a model-managed handoff: `run_query`
returns a `runId`, the model maps `runId`s to aliases in `execute_python.inputs`
(at most 8), and the main process pre-streams those artifacts before the code
runs. Artifacts, run ids, and alias maps were therefore all part of the model's
job.

Measurement against the DataAgentBench leader (54 tasks, 270 runs, 3180 Python
calls) showed the handoff is the wrong shape:

- It has no SQL tool at all. Databases enter Python as objects, and every result
  is fetched from inside the code.
- Tool results the model reads are tiny: median 465 characters, hard cap 5000,
  and not one exceeded 8000. Large result sets never enter the context.
- In-process frames are nonetheless large: 14 of 54 tasks exceed 50k rows, three
  exceed a million, the largest is 3.3M. Every reason is row-level work SQL
  cannot do — JSON blob columns, free-text regex, `rapidfuzz` alignment, and
  `format='mixed'` dirty dates.

So "large result set" is a requirement of the compute process, not of the
context. Stela had fused the two, because a `run_query` result had to pass
through the model before it could be computed on. The leader needs no artifact
concept — not because its data is small, but because its driver and its Python
share a process.

Two further facts constrain the fix. Stela's Pyodide worker runs with
`jsglobals: Object.freeze({})`, so today Python holds no JS object at all.
And DuckDB's native scanner extensions cannot load under Wasm, so handing the
sandbox a real connection is not on the table even if we wanted to.

## Decision

**The sandbox fetches its own data through exactly one injected function,
`await query(connection, request)`, implemented as an authorized RPC back to the
main process. Credentials, connection resolution, sql-guard, and the execution
journal all stay in the main process; `execute_python.inputs` and the run-id
handoff are removed from the model's surface.**

- `request` is a SQL string, or a dict for MongoDB. It is validated by the same
  `normalizeDataQuery` the `run_query` tool uses, so both paths reject the same
  malformed and forbidden requests.
- `query()` is hard read-only: the main process calls `classifySql(sql, false)`
  and ignores `agentAllowMutations`. A mutation still requires the UI proposal
  on `run_query`.
- Only a connection **name** crosses into the sandbox. Configuration and
  credentials never leave the main process.
- Every `query()` gets a `runId` and a journal record, exactly like `run_query`.
- Artifacts are not removed. They remain the transport, audit, and replay
  mechanism; they simply disappear from the model's surface.
- Authorization mirrors artifact reads: the job must still be pending, and
  results are registered under a host-generated alias so the existing
  chunk-streaming path carries them unchanged.
- Budgets per execution: 32 `query()` calls, 2 GB materialized, a 60s inactivity
  timer that each completed query refreshes, and a 10-minute wall clock that
  refreshing cannot lift.
- `run_query` stays for inspection and chart binding. Its model-facing preview
  drops to 5 KB, and a truncated result is returned as `sampleRows` rather than
  `rows`, so a partial result can no longer be counted as a whole one.

## Options considered

- **`query()` RPC into the sandbox** (chosen): matches the leader's code shape,
  deletes the `run_query` -> `runId` -> `inputs` orchestration from the model's
  job, and keeps every security decision in the main process. Costs the airtight
  JS/Python isolation (see Consequences) and requires the model to write `await`.
- **Native DuckDB with scanner extensions ATTACHed to live databases**: one
  engine for federation and row-level work, but adds a native dependency, hands
  a SQL engine with filesystem and network functions the user's DSNs, cannot
  ATTACH MongoDB, and the existing `sql-guard` does not filter DuckDB's
  `read_csv` / `COPY` / `INSTALL` surface. Rejected.
- **Keep `inputs`, just raise the caps**: smallest diff, but leaves the model
  doing artifact bookkeeping — the exact orchestration the leader does not have,
  and the source of the run-id errors seen in v3/v4 traces. Rejected.
- **Subprocess CPython with real drivers**: closest to the leader, but requires
  shipping or requiring a Python environment, and gives model-authored code full
  host privileges. Rejected.

## Consequences

- **The sandbox is no longer airtight against JS.** Python now holds a JsProxy,
  and Pyodide states plainly that it is not a security sandbox against
  untrusted Python (`f.constructor("return globalThis")()` style escapes work).
  The remaining defenses, all of which must hold:
  - Production CSP is `default-src 'self'` / `connect-src 'self'`
    ([electron/main/security.ts](../../electron/main/security.ts)), and the
    renderer loads via `loadFile`, i.e. a `file://` opaque origin. An escape
    cannot reach the network.
  - A Web Worker has no `window` and no preload bridge, so `window.stela.*` is
    unreachable.
  - Credentials never leave the main process; only a connection name enters the
    sandbox.
  - `query()` is read-only in the main process, not in the sandbox.
  - Every `query()` is journaled and replayable.
- The DAB harness runs Pyodide in `node:worker_threads`, which carries Node
  privileges, so an escape there is worse than in the renderer. It is
  evaluation-only and never shipped; this is an accepted premise, not a
  mitigation.
- The model must write `await query(...)`. User code now runs through
  `pyodide.code.eval_code_async` to allow top-level await. Marked in the code
  with a `ponytail:` note: the upgrade path is JSPI plus
  `pyodide.ffi.run_sync` for a synchronous `query()`, once JSPI is reliably
  available under Electron.
- Database time now counts inside the Python job, which is why the timeout
  became an inactivity timer with a separate wall clock.
- A single execution can hold several large relations at once, so Wasm memory
  pressure is now reachable from one tool call rather than accumulated across
  several. The byte budget is the blunt guard.
- Re-evaluate if Pyodide gains a real isolation story, if JSPI makes `query()`
  synchronous, or if Wasm memory limits start blocking ordinary workloads.
