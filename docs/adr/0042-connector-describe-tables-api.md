---
type: ADR
id: "0042"
title: "Connector describeTables API for live column COMMENT"
status: active
date: 2026-07-29
---

## Context

[ADR-0041](./0041-agent-live-schema-authority.md) moved the agent's
`search_tables` / `get_table_schema` to the live connector and noted that
column COMMENT is the main carrier of business terminology but stops short of
restoring a COMMENT-aware ranker. Implementing that ranker on top of
`listTables` requires either rebuilding a cache or probing every candidate
table with `SHOW CREATE TABLE` / `DESCRIBE` / `SELECT ... LIMIT 0`. Each
probe is a separate round trip, asks the connector to translate three
different SQL dialects into the same `{name, type, comment}` shape, and keeps
the proxy chain fragile when the connector (e.g. a StarRocks HTTP gateway)
does not understand `SHOW CREATE`.

## Decision

**Add an optional `describeTables(kind, config, tables)` method to the
`Connector` interface and to the subprocess protocol. The agent's schema
resolver calls it first; if it is unimplemented or returns no rows it falls
back to the existing show-create → describe → limit-zero ladder. Schema
resolver never duplicates or caches the result.**

## Options considered

- **`describeTables` per connector** (chosen): plugin keeps its own dialect
  translation, gets one round trip per lookup, and surfaces COMMENT through
  the same field the schema resolver already accepts.
- **Cache live DDL via the schema resolver**: avoids per-call probes, but
  recreates the same dual-authority risk that ADR-0041 removed.
- **Stay on the three-SQL probe ladder**: simple, but each connector has to
  re-translate `DESCRIBE` to non-MySQL dialects and we keep the awkward
  empty-string fallback to `LIMIT 0`.

## Consequences

- Plugin authors implement `describeTables` once per connector. Sample
  plugins will gain an implementation that runs `DESCRIBE` against the
  gateway / driver and maps the result columns to `{name, type, comment}`.
- The schema resolver stays the only place that converts descriptors into
  AiSchemaTargetContext, so call sites (`search_tables`,
  `resolveNamedTableSchemas`) need to add the optional dep, not duplicates.
- `TableDescriptor` is part of `plugin-sdk` and goes back into
  `@shared/types`; older plugins that pre-date this ADR continue to load
  because `describeTables` is optional.
- Re-evaluate if the policy is wrong: if a connector cannot honour
  `describeTables` and must rely on three-probe mode, log a single warning
  per run instead of asking every caller to handle the fallback.
