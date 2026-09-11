---
type: ADR
id: "0105"
title: "Dashboard conversation sources"
status: active
date: 2026-09-11
---

## Context

Dashboard enumerates device-local Agent History, but durable Chat tabs keep their
history inside `.stela.chat` files (ADR-0100). Their model metrics are recorded but
their sessions cannot be discovered or opened from Dashboard.

## Decision

Dashboard gets a dedicated read-only session listing that combines local Agent
History with visible Vault Chat files. A typed source reference selects history
by device/session or Chat by Vault path/session. Details project existing turns
and join local Metrics by run id without creating another history authority.

## Options considered

- **Read both authorities** (chosen): includes existing files and SQL-only turns
  without migration or duplication; listing must inspect Chat files.
- Copy Chat sessions into Agent History: adds conflicting ownership and retention.
- List Metrics sessions alone: loses SQL-only turns and history after metric expiry.

## Consequences

The Agent Panel's history/resume API remains unchanged. Chat inspection does not
write, recover, or replay a conversation. Path containment and session identity
are checked on detail reads. Synced Chat files can be inspected without claiming
their runs originated on this device; absent local metrics stay unavailable.
SQL outcomes and persisted lifecycle state are projected explicitly, without
inventing model calls or completion timestamps. Directory traversal follows the
Vault browser exclusions and does not follow symlinks. Unreadable sources produce
listing warnings while other sessions remain usable. Refresh remains explicit;
large Vaults may eventually need a disposable source index.
