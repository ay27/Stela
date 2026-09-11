---
type: ADR
id: "0103"
title: "Structured messages in durable conversations"
status: active
date: 2026-09-10
---

## Context

Durable chat files currently persist plain text, while Agent messages already carry ordered resource references.

## Decision

Add optional draftMessage and turn.message fields to version-1 conversation files and optional structured message arguments to the existing typed draft/submit IPC. Validate with the same message schema as Agent requests. Legacy draft/input strings remain readable projections; structured fields, when present, are authoritative. Existing files need no eager migration. Older application versions are not supported as structured-draft writers.

Only resource-free SQL may take the direct execution route. Structured messages reach AgentHarness intact. New drafts typed while a run is active are saved independently and never automatically submitted.

## Options considered

- Additive structured fields (chosen): reads existing files without a bulk migration.
- Encode references in plain text: loses identity and confuses literal text with user-authorized references.

## Consequences

Main derives legacy text from structured content and checks reference integrity. Conflict checks, cancellation and per-statement mutation approval remain unchanged. Full resource bodies remain bounded by existing Agent message limits.
