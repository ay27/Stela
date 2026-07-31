---
type: ADR
id: "0047"
title: "Bounded device Agent history retention"
status: active
date: 2026-07-31
---

## Context

Device-sharded Agent session JSONL files are Git-synced and otherwise retained
indefinitely. Unlimited sessions make the history menu and repository grow
without a useful default bound.

## Decision

**Retain the 20 most recently updated Agent sessions per device.** When a local
run finishes, Stela removes only older files from that device's
`.stela/agent-history/<deviceSlug>/` directory. It never deletes another
device's shard.

## Options considered

- **Per-device newest 20** (chosen): bounds local write growth without breaking
  per-device write isolation.
- **Global newest 20 across devices**: can delete remote device history and
  violates the shard ownership rule.
- **Time-based expiry**: depends on user activity patterns and offers less
  predictable retention.

## Consequences

- A device can continue its 20 newest sessions after restart; older local
  sessions are no longer available through history or model context.
- Git records normal file deletions for the local shard; other device files
  remain untouched.
- Re-evaluate if users need pinned sessions, configurable retention, or
  archival rather than deletion.
