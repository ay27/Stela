---
type: ADR
id: "0040"
title: "Native vault watcher backend"
status: active
date: 2026-07-28
---

## Context

The vault watcher incrementally updates in-memory vault and SQL indexes, plus
notifies the renderer about external Markdown changes. Chokidar 5 recursively
creates a Node `fs.watch` handle for many paths. On macOS, a vault with about
1,500 files created about 1,600 `FSEventWrap` handles; closing them could block
application exit for tens of seconds. Setting `persistent: false` prevents the
handles from keeping the process alive, but does not reduce their resource cost.

## Decision

**Use `@parcel/watcher` as the vault watch backend. Keep the existing
`VaultFsEvent` contract (`added` / `changed` / `removed`), batching, ignore
rules, and self-write suppression unchanged.**

## Options considered

- **`@parcel/watcher`** (chosen): one native recursive subscription per vault
  root across macOS, Windows, and Linux; adds one Electron-native dependency.
- **Keep Chokidar 5**: preserves implementation simplicity, but retains the
  per-path handle model and known macOS shutdown cost.
- **Direct `fs.watch({ recursive: true })`**: avoids a dependency on macOS and
  Windows, but requires Stela to implement event classification, write
  stabilization, and a separate Linux backend.
- **Watchman**: efficient, but requires users to install and operate an
  external daemon.

## Consequences

- The main-process watcher now depends on a native module and Electron rebuild
  covers it alongside `better-sqlite3`.
- Rename remains delete plus create; consumers do not receive a new event type.
- Parcel events lack Chokidar's `awaitWriteFinish`; Stela retains a path-level
  write-stabilization delay before publishing updates.
- Re-evaluate if native subscription teardown blocks shutdown, platform event
  semantics diverge from the existing contract, or vault scale exceeds the
  incremental-index budget in ADR-0010.
