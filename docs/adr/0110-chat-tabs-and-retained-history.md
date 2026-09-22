---
type: ADR
id: "0110"
title: "Chat tabs and retained local history"
status: active
date: 2026-09-15
---

## Context

Supersedes [ADR-0108](0108-unified-chat-lifecycle.md) and [ADR-0047](0047-bounded-device-agent-history-retention.md). Storage labels and prominent Save/Discard controls made closing a Chat look destructive. The newest-20 cleanup did not match users' expectation of recoverable history.

## Decision

One Main-owned conversation identity and execution service still serves both presentations. Sidebar tabs track open views in memory; workspace tabs remain authoritative for main-area placement. Moving preserves identity, draft, connection, scroll, pending decisions and execution. Closing only closes the view. Non-empty conversations and legacy histories remain locally retained without count-based pruning; blank sessions remain memory-only.

Present all histories uniformly. File-backed conversations display their filename and Vault-relative directory. The more menu offers explicit promotion as “Store as local file”; promotion keeps identity and uses serialized, etag-checked persistence with subsequent autosave. It is unavailable during foreground execution. Existing formats and on-demand legacy import remain compatible; result rows remain journal/cache references and never replay automatically. No user-facing discard operation is offered in this revision.

## Options considered

- Tabs with retained local history and optional file promotion (chosen).
- Keep a single view and the newest-20 policy: simpler state but misleading history expectations.

## Consequences

Local history may grow; lists search and progressively reveal entries. Open-tab layouts are not persisted across app restarts. No new IPC or file format is needed. Existing protection/discard APIs remain compatible, but protection no longer deletes history. Existing execution, security, path confinement and maintenance-attribution boundaries remain in force.
