---
type: ADR
id: "0025"
title: "Quit checkpoint feedback and restricted export reveal"
status: active
date: 2026-07-22
---

## Context

The final AutoGit checkpoint runs during `before-quit`, so users need visible feedback while the application deliberately waits. Exported files are intentionally saved outside the vault, but the existing shell bridge may reveal only vault paths.

## Decision

**Main broadcasts a typed quit-checkpoint event before waiting for the final local commit. Export saves use a native dialog and return an ephemeral reveal token; only that token can reveal the file in the system file manager.**

## Options considered

- **Typed event and ephemeral token** (chosen): keeps the renderer unprivileged and makes the in-progress state and reveal target explicit.
- **Renderer-supplied absolute path**: simpler, but expands the shell bridge to arbitrary filesystem paths.
- **Browser download for result exports**: keeps the old flow, but cannot reliably identify the saved file.

## Consequences

- The quit overlay indicates work in progress but does not impose a timeout; a slow Git hook or filesystem can still delay exit.
- CSV, JSON, and Excel exports use the same native save flow as Markdown.
- Reveal tokens are process-local and bounded; after restart or eviction, the user can still locate files manually but cannot use the old success action.
