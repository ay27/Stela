---
type: ADR
id: "0114"
title: "Pi owns context compaction scheduling and recovery"
status: active
date: 2026-09-23
---

## Context

Supersedes the compaction orchestration decision in [ADR-0113](0113-pi-durable-session-upgrade.md); its session migration, persistence, retry and no-replay decisions remain in effect. Stela previously disabled native automatic compaction and checked history once before each user request, then retried an overflow with a synthetic user prompt. Pi 0.87 already handles threshold compaction at run checkpoints and bounded overflow recovery.

## Decision

Use Pi's default compaction settings, scheduling, summarization and overflow recovery. Remove Stela's duplicate threshold check and overflow continuation prompt. Keep the adapter thin: forward native compaction events into the existing UI protocol, reporting completion only for a successful native outcome. Keep Stela's bounded resource retrieval, query artifacts, plan/checkpoint projectors and generation-only transport recovery. Do not replace Pi summarization through a custom compaction hook.

## Options considered

- **Native Pi compaction (chosen):** shares upstream lifecycle and future improvements; requires integration tests at storage and event boundaries.
- Stela scheduling around native manual compaction: duplicates upstream decisions and misses checkpoints inside long tool runs.
- Custom summarization pipeline: greater maintenance cost and another source of lifecycle inconsistency.

## Consequences

Threshold policy and retained history follow the pinned Pi version. Compaction is lossy and does not replace durable evidence or on-demand retrieval. Native threshold scheduling is checkpoint-based, not a claim that every final provider payload has an exact token count. Test automatic threshold compaction, tool continuation without replay, overflow, cancellation, persistence and projected custom entries on future Pi upgrades. Existing IPC and storage formats do not change.
