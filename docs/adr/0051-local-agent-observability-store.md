---
type: ADR
id: "0051"
title: "Local Agent observability store"
status: active
date: 2026-08-03
---

## Context

Stela exposes several AI surfaces—one-shot actions, SQL inline completion, the
Harness Agent, tools, and automatic Skill maintenance—but previously retained
no common reliability or latency metrics. Agent JSONL history is optimized for
conversation replay, retains only twenty sessions per device, and does not
contain completion acceptance or every maintenance outcome. The existing
`.stela.sqlite` is explicitly disposable and rebuildable from execution JSONL,
so using it as the sole observability authority would violate its deletion
contract. Full local traces can also contain prompts, SQL, note contents, and
answers and therefore must never enter Git.

## Decision

**Store AI and Agent observability in a separate gitignored, Vault-local
`{vault}/.stela/agent-metrics.local.sqlite` authority with a fixed 90-day
retention period. Expose only typed aggregate, trace, inline-disposition, and
clear operations through preload IPC.**

Metrics use surface-specific funnels instead of one global success score.
Traces include redacted prompts, tool arguments, summaries, and answers with a
256 KiB limit per JSON payload. API keys are never recorded. Automatic Skill
maintenance remains a Vault setting and can disable both post-run maintenance
and stale-Skill refresh; explicit knowledge saves remain available.

## Options considered

- **Separate local SQLite authority** (chosen): efficient aggregate queries and
  trace drill-down without Git conflicts; adds another lifecycle-managed store.
- **Add tables to `.stela.sqlite`**: fewer files, but deleting the documented
  disposable result cache would unexpectedly erase the only metrics authority.
- **Git-synced JSONL**: reviewable and portable, but full traces create privacy,
  merge, retention, and repository-growth problems.
- **Aggregate only in memory**: smallest implementation, but cannot diagnose a
  previous slow or failed run.

## Consequences

- Dashboard data stays on the current installation and Vault and is not a
  cross-device usage report.
- Users can inspect and clear full local traces; old records are deleted after
  90 days.
- Every AI surface must settle each metric run exactly once and use typed child
  runs for tools and maintenance.
- Storage/schema changes require migrations and lifecycle tests even though no
  cloud telemetry or new dependency is introduced.
- Re-evaluate if users need encrypted traces, cross-device aggregation, or
  configurable retention.
