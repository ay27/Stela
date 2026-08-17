---
type: ADR
id: "0067"
title: "Safe MongoDB aggregation queries"
status: active
date: 2026-08-17
---

## Context

Supersedes [ADR-0066](0066-structured-read-only-agent-queries.md).

Structured MongoDB `find` made non-SQL data available to the Agent, but it
forces the model to enumerate documents when the answer needs grouping,
sorting, string expressions, or counts. That is slow, expensive, and more
error-prone than asking MongoDB to compute a bounded result. Unrestricted
pipelines would reintroduce writes, cross-collection reads, server-side
JavaScript, and unbounded resource use.

## Decision

**`run_query` and connector API v4 support a typed, read-only MongoDB
aggregation operation with a small stage allowlist and host-owned resource
limits. Connectors declare their MongoDB operations independently from their
query languages.**

Existing SQL behavior and MongoDB find requests remain compatible. Aggregation
allows match, projection/field transforms, unwind, group, sort, pagination,
count, and root replacement. It rejects write stages, cross-collection stages,
facets, unknown stages, and server-side JavaScript at every nesting depth.
Pipeline length, serialized size, nesting depth, execution time, and output
artifacts are bounded by the host rather than model parameters.

DataAgentBench maps the same typed request to its dataset MongoDB service. Its
official `QueryDBTool` remains the path for SQL and find; the bridge performs
aggregation directly because the upstream tool has no pipeline input.

## Options considered

- **Safe typed aggregation subset** (chosen): moves relational work into the
  database while preserving a reviewable, read-only contract.
- **Keep find-only and rely on Python**: safe but transfers and materializes far
  more data for ordinary single-database questions.
- **Expose arbitrary pipelines**: expressive, but permits writes and expensive
  cross-collection operations that are inappropriate for a model-facing tool.
- **Add a second Mongo aggregation tool**: avoids changing the request type but
  duplicates connection selection, audit, artifact, and prompt behavior.

## Consequences

- Connector plugin API v4 adds Mongo operation capabilities and an aggregation
  request variant; older plugins remain valid and default to find-only.
- MongoDB can answer common grouped/ranked questions in one audited query, and
  aggregation results use the same preview and JSONL artifact path as find.
- The stage allowlist intentionally excludes `$lookup`, `$facet`, and writes;
  cross-database and cross-collection work remains an `execute_python` concern.
- TypeScript and Python adapters must share conformance fixtures so their
  defense-in-depth validators cannot silently diverge.
- Re-evaluate the allowlist only from demonstrated product queries, not from a
  benchmark-specific failure.
