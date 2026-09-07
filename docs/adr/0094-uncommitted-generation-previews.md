---
type: ADR
id: "0094"
title: "Uncommitted generation previews"
status: active
date: 2026-09-06
---

## Context

[ADR-0092](0092-bounded-generation-recovery.md) buffers generation before harness
commit. The Agent Panel should still display responsive progress without committing
failed partial tool calls or text to model history.

## Decision

**Send visible-text previews through the existing ephemeral assistant-progress UI
channel, separately from the buffered provider-to-harness stream.** Clear previews
on failed attempts; only successful snapshots enter durable history and tool dispatch.

## Options considered

- **Ephemeral preview callback** (chosen): preserves streaming UX and tool atomicity.
- Buffer all user-visible text: correct but unnecessarily unresponsive.
- Forward failed streams into the harness: ambiguous history and duplicate actions.

## Consequences

UI previews are provisional, never evidence of completion. They use existing
reasoning-tag filtering and snapshot replacement, not an append-only delta stream.
Failure clears pending preview timers. Preview/diagnostic callback failures must not
cause provider retries. No new IPC capability or persistent content is introduced.
