---
type: ADR
id: "0060"
title: "Cache-stable Agent prompts and immutable plan snapshots"
status: active
date: 2026-08-11
---

## Context

Supersedes [ADR-0038](0038-runtime-agent-execution-plans.md).

The Agent system prompt included request-specific connection, table, note,
Canvas, locale, and ranked-Skill content. Its execution plan was projected from
one mutable Session custom entry and replaced between runs. Both behaviors
change an early prompt segment and prevent providers from reusing the otherwise
stable Stela policy, tool definitions, and prior transcript.

## Decision

**Keep one invariant Agent system prompt and deterministic tool list, place all
request-specific context in a bounded and redacted user-turn envelope before
the user's final request, and append every execution-plan version as an
immutable Session custom entry. Use pi-ai's provider-neutral short prompt-cache
retention and session affinity instead of emitting vendor payload fields.**

Plan entries carry `runId` and monotonically increasing `version`; only the
highest version for the current run is active. No empty plan entry is appended.
Compaction must retain the current plan and evidence.

## Options considered

- **Stable prefix plus immutable plan snapshots** (chosen): maximizes reusable
  prefixes and keeps plan recovery explicit; retains a bounded history of plan
  versions until compaction.
- **Move only dynamic system text**: improves the first breakpoint but mutable
  plan projection still invalidates the transcript.
- **Inject only the latest virtual plan at request time**: avoids persistence,
  but removing the virtual message on the following turn still changes an
  already-sent prefix.
- **Provider-specific cache controls**: allows fine tuning, but duplicates
  compatibility logic already owned by pi-ai and would break custom providers.

## Consequences

- System prompt output must be byte-stable across locale, connection, reference,
  Canvas, Skill, and quick-action changes.
- Dynamic context and the actual request are added only at the end of the
  transcript; tool definitions remain fixed for normal Agent runs.
- Plan custom entries become append-only and may add several small messages to
  long analyses; normal compaction bounds the cost.
- Short cache retention remains the portable default. Long paid retention is
  not exposed until measured workloads justify it.
- Cache-read and cache-write usage continue through existing Agent metrics.
