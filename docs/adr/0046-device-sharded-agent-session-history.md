---
type: ADR
id: "0046"
title: "Device-sharded Agent session history"
status: active
date: 2026-07-31
---

## Context

Agent Panel timelines and pi AgentHarness sessions currently live only in renderer
and main-process memory. Restarting the app loses both the visible history and
the model context needed to continue a conversation. The existing execution
history proves a Git-safe pattern for vault data: each device writes only its own
JSONL shard and every device reads all shards.

## Decision

**Persist Agent sessions as native pi JSONL files at
`{vault}/.stela/agent-history/<deviceSlug>/<sessionId>.jsonl`.** The current
device writes only its own directory; history browsing reads every device
directory. The same file contains Stela custom entries for Panel timeline
recovery. Opening a remote-device session is read-only; sending a new prompt
forks its pi context into a new local session before writing.

## Options considered

- **Native pi JSONL per device** (chosen): preserves compaction and tool context
  without a second serialization format, while avoiding concurrent cross-device
  writes.
- **Renderer-only timeline snapshot**: small implementation but a resumed chat
  loses model context.
- **SQLite authority with JSONL export**: adds a second history authority and
  complicates Git merge and recovery.

## Consequences

- Agent history is vault-scoped, human-readable JSONL, and Git-synced like run
  history; API keys and other secrets must never be written into it.
- A crashed run remains visible as interrupted, and unresolved proposals are
  display-only after recovery.
- Remote sessions can be inspected across devices but never receive writes;
  continuing one creates a local branch with a new session id.
- Re-evaluate if sessions become large enough to need retention controls,
  encrypted history, or a shared collaborative conversation model.
