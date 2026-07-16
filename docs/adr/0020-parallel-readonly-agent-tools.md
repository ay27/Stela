---
type: ADR
id: "0020"
title: "Parallel read-only agent tools; sequential for SQL and proposals"
status: superseded
superseded_by: "0021"
date: 2026-07-16
---

## Context

[ADR-0018](0018-pi-ai-agent-harness.md) set every agent tool to `executionMode: "sequential"` so proposal waits stay ordered. That also serialized independent read-only lookups (`get_table_schema`, `search_vault`, `read_note`, …) even when the model emitted them in one turn. pi-agent-core already supports turn-level parallel tool execution; a batch becomes sequential if any call in it targets a sequential tool.

## Decision

**Mark read-only agent tools `executionMode: "parallel"`. Keep `run_sql` and `propose_edit` as `sequential`.** Future tools follow the same rule: parallel if side-effect-free; sequential if they need proposal UX or shared mutable DB state.

## Options considered

- **All sequential** (ADR-0018 default): simplest proposal ordering; wastes wall-clock on independent schema/vault fan-out. Rejected for read-only tools.
- **All parallel**: faster fan-out, but concurrent proposal waits and concurrent `run_sql` against one connection are harder to reason about in UI and connectors. Rejected.
- **Read-only parallel / SQL+propose sequential** (chosen): uses pi's built-in batch rule; subprocess connectors already mutex internally when contended.

## Consequences

- Same-turn batches of only read-only tools run concurrently; mixing in `run_sql` or `propose_edit` forces the whole batch sequential
- Subprocess connectors may still serialize under their internal lock; vault/search and in-process connectors benefit immediately
- Does not introduce multi-agent / subagent orchestration
- Re-evaluate if concurrent SELECTs need true parallelism on a single subprocess connector (would need connector-level pooling, not just tool flags)
