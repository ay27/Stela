---
type: ADR
id: "0096"
title: "Explicit knowledge-maintenance outcomes"
status: active
date: 2026-09-09
---

## Context

Background maintenance failures were displayed as "all knowledge maintained" when
no actions were saved. Console-only errors were easy to miss, and post-answer
events were not persisted with conversation history. Metrics alone did not make
these failures visible to the person using the Agent Panel.

## Decision

**Add optional typed outcome and bounded redacted diagnostics to the existing
maintenance event, persist background events to existing session history, and
display failures explicitly beside the completed answer.** No new IPC capability,
notification service, telemetry endpoint, or diagnostic storage is introduced.

The outcome distinguishes saved, no change, missing source, oversized input,
cancelled, timeout, turn limit, dropped, and error. Failed jobs retain their
original error and metric run ID even when actions were saved before the failure.
Legacy events without outcomes are unknown unless saved actions prove an update;
they must not imply maintenance succeeded. Cancellation and safe skips stay neutral.

## Options considered

- **Typed outcomes and inline diagnostics** (chosen): inspectable without interrupting
  active analysis; existing metrics/history remain the diagnostic authorities.
- Toast every background event: noisy and ephemeral.
- Infer success from an empty action list or parse summary strings: conflates errors
  with legitimate no-change results and breaks across languages.

## Consequences

Existing readers tolerate optional fields and old histories remain readable. UI
failure text must be localized; raw diagnostic messages must be redacted and bounded.
Errors do not invalidate the completed answer. This does not replace a future
process-wide fatal-error/logging policy or fix unrelated strict-type debt.
