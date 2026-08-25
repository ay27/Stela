---
type: ADR
id: "0076"
title: "Event-driven single-flight Git sync"
status: active
date: 2026-08-25
---

## Context

ADR-0007 established Git as Stela's cross-device sync transport, but the first
implementation used independent delayed commit and pull loops. App-owned writes
could wait two minutes, external edits refreshed the UI without scheduling Git,
and commit, pull, and push could overlap. Those gaps made cross-device changes
arrive late and increased avoidable non-fast-forward races.

Stela must remain local-first and Git-friendly. It must recognize edits made by
other local tools, protect dirty editor buffers, preserve Git conflict state for
manual resolution, and continue working if the native filesystem watcher is
unavailable. Git remains the only transport and history authority; no
preprocessing database, file replication daemon, or CRDT is introduced.

## Decision

**Use an event-driven renderer scheduler backed by one serialized main-process
Git transaction per Vault.** App writes and allowlisted external Vault changes
share a three-second quiet period; focus, network recovery, and a sixty-second
safety scan trigger an immediate attempt. Concurrent triggers coalesce into one
follow-up transaction.

The transaction checkpoints permitted local changes, fetches origin,
fast-forwards a purely-behind branch or rebases unpublished local checkpoints,
refreshes only domains changed by integration, and then pushes. One
non-fast-forward push race may fetch, integrate, and retry once. A genuine
merge/rebase conflict is left in Git's conflict state for the existing manual
resolver; Stela never auto-stashes or silently chooses a side.

The Vault watcher observes normal Vault files plus the Git-shared `.stela`
allowlist (`settings.json`, `connections.json`, `history/`, `agent-history/`,
`skills/`, and `sql-templates/`). Local caches, metrics, plugins, secrets, query
artifacts, SQLite, and Git internals remain excluded. Watcher events are hints,
not authority; the periodic Git attempt is the fallback.

All renderer requests cross the typed `git.syncNow` preload capability and a
Zod-validated IPC schema. Legacy `syncPush` and `syncPull` remain temporarily as
compatibility entry points but delegate to the same serialized orchestrator.

## Options considered

- **Event-driven single-flight Git sync** (chosen): low visible latency while
  retaining Git history and explicit conflicts; requires careful trigger
  coalescing and domain refresh.
- **Faster independent commit and pull timers**: smaller code change, but still
  permits overlapping Git operations and cannot reliably connect external edits
  to outbound sync.
- **Syncthing or another filesystem replication layer**: detects external edits
  well, but introduces a second transport authority and additional deployment
  and conflict semantics.
- **CRDT/custom sync service**: can support collaborative editing, but changes
  the storage model and is disproportionate to same-user, multi-device sync.

## Consequences

- With automatic Git settings enabled and Stela open, a quiet local/external
  change normally begins sync after about three seconds; network and remote
  latency still determine final visibility on another device.
- `sync-orchestrator` is the only owner of automatic commit/integrate/push
  ordering, including legacy IPC callers and the quit checkpoint.
- Dirty renderer tabs defer synchronization. Uncheckpointed local changes also
  block inbound-only sync; there is no hidden stash.
- Integrated paths are classified into `vault-files`, `history`,
  `agent-history`, `settings`, `connections`, `skills`, and `templates`, so the
  renderer reloads only affected clean state.
- Watcher failure degrades latency, not correctness: focus/network triggers and
  the sixty-second scan remain available.
- This should be re-evaluated if Stela needs simultaneous collaborative editing,
  Git repository size becomes impractical, or remote authentication latency
  makes frequent fetches unacceptable.
