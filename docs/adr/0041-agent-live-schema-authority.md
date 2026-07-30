---
type: ADR
id: "0041"
title: "Agent live schema authority"
status: active
date: 2026-07-28
---

## Context

Connections can optionally point at a local `schemaDir` containing manually
synced `db.table.md` DDL snapshots. The agent's `search_tables` and
`get_table_schema` tools currently prefer that snapshot whenever it exists,
then use live SQL later in the same turn. The resulting two schema authorities
can disagree: newly added tables are invisible to search, while stale columns
can enter the model context before a live query corrects them.

The dump remains useful for human review, external workflows, Action complete,
and latency-sensitive inline completion. Those uses do not require it to be
authoritative for the agent.

## Decision

**Agent `search_tables` and `get_table_schema` use the live connector as their
only schema authority. `schemaDir` remains an optional dump for the connection
UI, Action complete, and inline completion.**

## Options considered

- **Agent live connector only** (chosen): reflects the current database and
  eliminates schema divergence in agent tool turns; adds schema-discovery
  latency.
- **Continue preferring `schemaDir`**: avoids connector enumeration, but
  preserves stale-table and stale-column failures.
- **Remove `schemaDir` entirely**: gives one global authority, but removes
  dump UI and the zero-connector inline-completion fallback in the same change.

## Consequences

- Agent table search ranks live database and table names, then
  `get_table_schema` retrieves live DDL or a zero-row column probe.
- Agent search no longer has the local DDL/COMMENT catalog used by
  schema-dir lexical ranking; models must retrieve candidate table schemas
  before relying on business terminology.
- `schemaDir` serialization, Schema Dump UI, Action context, and inline
  completion remain unchanged.
- Re-evaluate if live catalog enumeration is too slow or unavailable for common
  connections; a future connector-backed catalog cache must have explicit
  invalidation and cannot silently replace live authority.
