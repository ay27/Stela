---
type: ADR
id: "0108"
title: "Unified temporary and saved Chat lifecycle"
status: superseded
superseded_by: "0110"
date: 2026-09-14
---

## Context

Chat tabs and the Agent sidebar share the same analysis capabilities but have different storage and task lifecycles. Users want disposable exploration, explicit promotion to a durable conversation, and movement between sidebar and workspace without losing state.

## Decision

One Main-owned conversation identity and execution service serves both presentations. New conversations use `.stela/chat-sessions.local/` recovery storage; empty drafts remain memory-only. Keep the latest 20 temporary sessions, protecting opened, running and background-maintained sessions. Explicit Save promotes a session to a `.stela.chat` file and enables subsequent automatic file saves. Preserve its identity, history and result references. Promotion is serialized with background writes and unavailable during a running foreground turn. Saved files are never retention-pruned.

Moving a conversation changes only its presentation. Closing a view does not cancel work. Discard explicitly removes a temporary session through trash and requires foreground/background work to settle first. Note changes do not implicitly change context. Task-specific entry points and resource locators remain explicit. Existing saved files retain their format; legacy Panel history is imported on demand, retaining original evidence and without replaying actions.

## Options considered

- Shared lifecycle with optional durable promotion (chosen).
- Automatically save every chat as a visible file: creates cleanup work for experiments.
- Keep separate implementations with similar UI: preserves divergence and duplicate state.

## Consequences

The IPC gains temporary creation, listing, promotion, protection and discard operations. Hidden local recovery state is not a portable archive. Saved conversation results remain references into the execution journal/cache, with explicit unavailable states rather than automatic query replay. Dashboard deduplicates by conversation identity. Low-level Agent/evaluation APIs remain available.
