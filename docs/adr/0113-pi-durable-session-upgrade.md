---
type: ADR
id: "0113"
title: "Pi 0.87 durable sessions behind Stela conversation adapters"
status: active
date: 2026-09-22
---

## Context

Pi 0.87 replaces the legacy Session and AgentHarness APIs with format-4 storage and lanes. Stela persists both standalone Agent journals and journals embedded in Chat documents. Existing conversations, tool approvals, generation-only recovery, and knowledge maintenance must survive the upgrade.

## Decision

Use Pi 0.87 for transport and execution, with a main-process adapter for Stela's single main lane. Reuse Pi's native v3 reader and atomic first-write migration. Preserve the original journal before migration; merely reading history must not rewrite it. Chat publication remains owned by the existing serialized, conflict-checked conversation service. Mark Chat documents containing format-4 journals as version 2, accepting version 1 for import. Old clients require the retained pre-migration backup to resume old conversations; new sessions cannot be downgraded by changing the binary alone.

Keep Stela's UI event protocol, credentials, approval checks, bounded generation recovery, and maintenance policy. Disable nested Harness retry and automatic compaction; Stela retains their existing orchestration. Never resume interrupted tool effects automatically on open. Native durable operations are not a new background-job feature in this upgrade.

## Options considered

- Native v3 import with a small Stela adapter (chosen): keeps one runtime and upstream migration logic; requires explicit event and persistence compatibility tests.
- Rewrite all conversation storage and renderer events: unnecessary exposure of upstream implementation details and a larger regression surface.
- Keep two Pi runtime versions: duplicates provider behavior and leaves historical sessions on an unmaintained path.

## Consequences

The adapter must cover history projection, compaction, cancellation, recovery, and maintenance. Migration backups contain the same private data as their source and remain local. Import must never execute tools. Read-only inspection, interrupted migration, repeat opening, and continued conversation require regression coverage before release. Version pins and lockfile updates must travel together.
