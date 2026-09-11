---
type: ADR
id: "0104"
title: "Validated structured Canvas authoring"
status: active
date: 2026-09-11
---

## Context

Agent Canvas creation currently saves an empty file before accepting a complete
JSON string. Repeated schema errors can exhaust recovery while leaving that file
empty. The file envelope and Flow schema should not be reconstructed by a model.
ADR-0070 source auditing, atomic refresh, and user-owned layout remain required.

## Decision

**Agent create/update tools accept structured authoring content derived from the
existing Canvas schemas, validate the complete artifact and audited data before
writing, and publish an artifact link only after a successful save.**

The host owns document identity, timestamps, session attribution and audited source
metadata. Existing version-1 files and manual empty creation remain supported.
Legacy update JSON remains accepted for in-flight calls, behind identical checks;
new tool definitions advertise only structured content. Agent creation requires
at least one nonempty card. Updates preserve etags, layout and atomic refresh.

Use the already-transitive zod-to-json-schema package as an explicit dependency
to derive provider JSON Schema from Zod, with no hand-maintained parallel schema.
Runtime refinements remain authoritative and return actionable validation errors.
Renderer card boundaries isolate render failures and report them visibly. Main
validates data and structure, never executes Renderer code or claims that a file
has rendered merely because it was saved. Actual component regression tests
cover reading and rendering mixed artifacts and local card failures.

## Options considered

- Structured authoring plus validation before persistence (chosen): prevents
  incomplete files, retains a single schema authority, increases tool schema size.
- More JSON prompt examples: smaller schema, but repeated guess-and-retry failures.
- Main-process headless rendering for every write: crosses process responsibilities
  and adds latency without establishing business correctness.

## Consequences

- Existing Canvas storage, layout and IPC remain compatible. No database execution
  is performed by validation; saved query metadata/results are used.
- Invalid creation emits no created event and leaves no file; invalid updates leave
  the prior bytes intact. Validated persistence and actual rendering are separate.
- Tests include malformed Flow authoring, bad data bindings, file round trips,
  mixed-card component rendering and failure isolation. Business conclusions still
  require independent evidence; successful rendering does not certify them.
