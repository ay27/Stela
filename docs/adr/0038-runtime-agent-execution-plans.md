---
type: ADR
id: "0038"
title: "Runtime linear agent execution plans"
status: active
date: 2026-07-28
---

## Context

Long-running data analysis can require schema discovery, metric-definition checks, several SQL runs, and explanation. Session compaction preserves conversational history but cannot guarantee that a model retains the current analysis objective, completed evidence, and remaining acceptance conditions. Exposing every tool call and model reasoning to the user also makes the Agent panel difficult to scan.

## Decision

**Agent runs keep a bounded linear execution plan in main-process memory.** The plan is surfaced through a typed `plan_updated` event and injected into each pi-agent-core Session context as its latest custom entry; it is not persisted to Vault, JSONL, or Git.

## Options considered

- **Runtime plan + Session custom entry** (chosen): survives context compaction during an active app session without adding storage or sync semantics.
- **Prompt-only TODO list**: lowest implementation cost, but compaction can omit it and the model can silently drift.
- **Vault-persisted plan journal**: supports resume after restart, but adds a new user-data authority, privacy decisions, and Git synchronization behavior.

## Consequences

- Plan state disappears on app restart, matching existing in-memory Agent Session behavior.
- Agent tools must create/update plans through validated main-process state; the renderer cannot synthesize or mutate plan state.
- Ordinary tool activity is grouped in the UI, while confirmation proposals stay visible.
- Re-evaluate this decision if users need to resume unfinished analysis after restart; that would require a separate persisted run-journal ADR.
