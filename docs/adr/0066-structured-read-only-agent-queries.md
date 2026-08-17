---
type: ADR
id: "0066"
title: "Structured read-only Agent queries across connector languages"
status: superseded
superseded_by: "0067"
date: 2026-08-16
---

## Context

Supersedes [ADR-0013](0013-agent-tools-sql-guard-and-proposals.md).

The Agent originally exposed `run_sql({ sql })`, so every connector and audit
record implicitly represented SQL. DataAgentBench includes MongoDB datasets,
and product users also need to combine results from heterogeneous connections
through the existing session artifact and sandboxed Python flow. Encoding a
MongoDB request as a pseudo-SQL string would weaken validation, obscure audit
history, and create benchmark-only behavior.

The existing SQL safety decision must remain true: multi-statement SQL is
blocked, mutations require both policy enablement and explicit user approval,
and note edits never happen without a proposal.

## Decision

**The Agent exposes one `run_query` tool whose discriminated request is either
SQL or a structured, read-only MongoDB find, and connectors declare the query
languages they support.** Connector plugin API v3 adds `queryLanguages`,
`executeQuery`, and `materializeDataQuery`; SQL-only v1/v2 plugins continue
through their existing `execute` and `materializeQuery` methods.

SQL requests still pass through `sql-guard`. MongoDB requests contain only a
database, collection, JSON filter, optional projection, and bounded limit.
Aggregation pipelines, writes, and server-side JavaScript operators are not in
the contract. The official MongoDB connector implements that contract and may
stream JSONL to a host-selected session artifact. Audit history stores the
query language and a canonical query representation while retaining the
existing `sql` field for backward-compatible history packages.

DataAgentBench uses the same `run_query` request and delegates it to DAB's
official `QueryDBTool`. Bridge-call timeouts are fatal to that run and preserve
their original machine-readable cause. Validation uses a separate bridge so a
stuck query process cannot poison the validator. Headless Linux does not expose
desktop `execute_python`; cross-connection Python remains a product-runtime
capability verified separately on macOS.

## Options considered

- **Keep `run_sql` and add a Mongo-specific Agent tool**: smaller connector
  change, but duplicates selection, audit, artifact, and prompt behavior.
- **Translate MongoDB to pseudo-SQL in the benchmark bridge**: avoids a product
  feature but makes benchmark results non-product and loses a safe typed input.
- **Expose unrestricted Mongo commands or aggregation pipelines**: more
  expressive, but substantially expands the mutation and JavaScript attack
  surface.
- **One discriminated `run_query` contract** (chosen): keeps one model-facing
  path and lets connector capabilities determine the supported language.

## Consequences

- `RunRecord.queryLanguage` defaults to `sql`, so old SQLite rows and JSONL
  history remain readable.
- The model can query MongoDB with bounded read-only finds and feed large
  results into the same local artifact contract used by SQL.
- Canvas sources and charts remain SQL-only in this version; MongoDB results
  are chat/Python inputs rather than refreshable Canvas queries.
- Product prompts publish whether vault, Skill, SQL-history, Canvas, and
  clarification context are available, preventing calls to intentionally empty
  benchmark sources without changing the cache-stable tool list.
- Re-evaluate when users need a safe, typed aggregation-pipeline subset or
  durable non-SQL Canvas sources.
