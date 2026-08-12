---
type: ADR
id: "0062"
title: "Implicit Workspace context and explicit inline resources"
status: active
date: 2026-08-12
---

## Context

Supersedes [ADR-0061](0061-ordered-inline-agent-message-resources.md).

The ordered resource message fixed positional ambiguity for resources users
actively reference, but representing the current Workspace tab as an automatic
pill made every draft verbose and suggested the user had authored a reference
they never inserted. The current tab is execution environment, while an inline
pill is part of the user's statement; those concepts need different contracts.

## Decision

**Send the current note or Canvas as implicit per-turn Workspace context without
rendering it in the composer or timeline. Keep only user-inserted resources as
ordered inline message pills backed by the deduplicated resource catalog.**

The current tab is captured when a run starts. The main process validates and
places it in the dynamic turn envelope after the stable prompt prefix. It tells
the model which read tool establishes the resource contents but does not route
the model to a predetermined action.

## Options considered

- **Implicit current tab plus explicit inline pills** (chosen): keeps the draft
  concise while preserving positional meaning for deliberate references.
- **Automatic current-tab pill**: makes all context visible, but is noisy and
  conflates environment with user-authored content.
- **No automatic current-tab context**: simplest message model, but common note
  and Canvas questions would repeatedly require manual references.

## Consequences

- Composer and user timeline no longer display the automatic current note or
  Canvas; auditing remains available in the persisted run request.
- Switching Workspace tabs before sending changes the implicit context to the
  tab that is current at send time. Explicit pills remain unchanged.
- Legacy requests keep their historical decoding; positions or intent that old
  formats never recorded cannot be reconstructed.
- Re-evaluate if users need to pin an implicit context independently of the
  active Workspace tab.
