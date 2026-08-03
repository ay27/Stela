---
type: ADR
id: "0049"
title: "Independent bounded Skill maintenance"
status: active
date: 2026-08-03
---

## Context

Automatic Skill maintenance currently runs after the final answer but before the
Agent session lock is released. The renderer treats the answer as complete, so a
new prompt can be submitted while main still rejects that session as busy. The
maintenance harness can also spend several model turns retrieving evidence.

## Decision

**Finish and unlock the conversational Agent run before scheduling Skill
maintenance on an independent Vault-scoped queue. Bound each maintenance job to
60 seconds and five model turns, with at most one running and one pending job per
Vault.** On-demand refresh has priority over opportunistic post-run maintenance.

## Options considered

- **Independent bounded queue** (chosen): keeps chat responsive and bounds model
  work, at the cost of a small independent lifecycle to manage.
- **Keep maintenance inside the Agent run**: preserves one lifecycle but exposes
  a completed-looking answer while the session remains locked.
- **Cancel maintenance on every new prompt**: favors chat but prevents durable
  knowledge in active conversations.

## Consequences

- New prompts can start as soon as the main answer and history are durable.
- Maintenance has its own cancellation and queue semantics and must correlate UI
  events by the originating run ID.
- Only the Skill file is the durable maintenance authority; background status is
  best-effort presentation state.
