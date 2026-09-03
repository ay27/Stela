---
type: ADR
id: "0086"
title: "Declarative query sources for sandbox Python"
status: active
date: 2026-09-03
---

## Context

Supersedes [ADR-0079](0079-sandbox-query-rpc.md).

ADR-0079 removed the model-managed `run_query` → `runId` → Python-input
handoff and let Python fetch complete data through `await query(connection,
request)`. DataAgentBench showed that this made the data path shorter but left
too much protocol work inside an untyped Python string. In one 104-case run,
70 of 72 database-routing errors happened inside `execute_python`; common
failures also included omitted collections, missing `await`, treating DuckDB
relations as pandas objects, and reusing variables across fresh executions.

Most Python analyses know their independent source queries before code runs.
Those queries do not need a separate model turn or a dynamically constructed
request, and their routing fields can be validated before starting Pyodide.

## Decision

**`execute_python` accepts optional declarative `sources` alongside one
self-contained `code` program. The Harness validates and executes known sources,
injects them by alias, and retains `await query()` only for requests whose shape
depends on earlier Python computation.**

- A source contains an alias, optional connection name, and the same structured
  SQL or MongoDB request accepted by `run_query`; it never contains a `runId`,
  artifact path, or credential.
- All source shapes and aliases are validated before any source runs. Sources
  are read-only, audited, and credited to the Python result's source lineage.
- Python reads a staged source with `tables[alias]` as a DuckDB relation or
  `to_df(alias)` as a pandas DataFrame.
- Each `execute_python` call remains a fresh stateless sandbox. A later call
  must declare its sources and variables again.
- Up to eight declarative sources are accepted. Staged sources and dynamic
  `query()` calls share the existing limit of 32 queries and 2 GiB per job.
- The existing artifact transport, Connector contract, process boundaries, and
  storage lifecycle are unchanged by this decision. Removing that transport is
  a separate future decision.

## Options considered

- **Declarative sources plus dynamic `query()`** (chosen): removes routine
  routing and async syntax from Python while preserving data-dependent queries;
  adds one compound tool schema and two supported access forms.
- **Prompt fixes only**: smallest change, but malformed routing remains hidden
  inside arbitrary Python and still consumes a model round trip to diagnose.
- **Declarative sources only**: simplest runtime surface, but cannot support a
  query built from ids, symbols, or predicates discovered during the same
  analysis.
- **Return to `runId` inputs**: reuses old machinery but restores the extra
  model turns and artifact bookkeeping rejected by ADR-0079.

## Consequences

- Common cross-database work fits in one tool call without requiring the model
  to spell `await query()` correctly for every independent source.
- The tool can reject duplicate aliases, incomplete MongoDB requests, and
  malformed SQL sources before Pyodide starts, with an exact source index.
- The model-facing tool schema grows, so descriptions stay compact and under
  the existing provider tool-budget test.
- Two query forms remain. Tool guidance must consistently prefer `sources` and
  reserve `query()` for genuinely dynamic requests.
- Benchmark acceptance must prioritize strict answer validity over fewer tool
  failures; a sharper trajectory that lowers correctness is not accepted.
