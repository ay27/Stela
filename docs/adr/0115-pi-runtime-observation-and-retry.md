---
type: ADR
id: "0115"
title: "Reuse Pi runtime observation, usage and generation retry"
status: active
date: 2026-09-23
---

## Context

Extends ADR-0114 and refines the generation recovery boundary in ADR-0111. Stela's adapter subscribes to a subset of runtime events and counts only assistant message usage, omitting native structural requests. Its transport wrapper also owns a retry loop that Pi already provides.

## Decision

Consume the native lane watch and reduceLaneSnapshot for runtime observation, retaining Stela event names at the adapter boundary. Use native usage rows to charge main and maintenance Harness calls exactly once, including compaction. External strategy/closeout calls retain their explicit accounting. Use pi-ai retryAssistantCall for the sole generation retry loop; keep Harness and provider retries disabled. Stela retains stream deadlines, transient HTTP status normalization, Retry-After admission limits, bounded previews and diagnostics. No tool operation is retried by this transport helper.

## Options considered

- **Pi primitives with a thin adapter (chosen):** removes duplicate orchestration while preserving product-specific safety and presentation.
- Enable Harness retry immediately: changes visibility and persistence of failed partial responses and duplicates existing transport recovery.
- Keep handwritten loops and event selection: misses native operations and increases upgrade maintenance.

## Consequences

Retry timing follows Pi's exponential backoff. The existing three-attempt cap and recovery deadline remain. Native snapshots remain main-process objects; UI and IPC formats do not change. This does not enable background resumption, steering, or branching UI. Regression tests must cover compaction usage, snapshot completion, retry cancellation, partial-output isolation and no tool replay.
