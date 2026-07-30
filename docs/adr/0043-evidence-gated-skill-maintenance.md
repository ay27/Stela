---
type: ADR
id: "0043"
title: "Evidence-gated Skill maintenance"
status: superseded
superseded_by: "0044"
date: 2026-07-30
---

## Context

Supersedes [ADR-0037](0037-concise-verified-skill-maintenance.md).

Concise write limits do not prevent the maintenance agent from treating a final
answer as proof or from silently replacing valid historical knowledge after one
bad run. Existing Skills can also bypass validation when edited outside Stela.

## Decision

**Automatic maintenance is evidence-gated and create-only.** It runs only when
the completed agent turn has successful tool evidence, receives a bounded tool
evidence list plus task background, and may create but never overwrite or archive
a Skill. Failed attempts are eligible only when later successful evidence
explains the cause and replacement; transient failures are never retained.

**All loaded Skills must pass the same validation as writes, and retrieval
returns only positive lexical matches.** Live connector schema remains
authoritative over any retained Skill.

## Options considered

- **Evidence-gated create-only automation** (chosen): preserves low-friction
  learning while preventing final-answer invention and destructive drift.
- **Prompt-only restrictions**: cheap but cannot reliably protect stored
  knowledge or externally edited files.
- **TTL, confidence scores, or review queues**: add lifecycle state and UI
  without evidence of enough library scale to justify them.

## Consequences

- Some useful knowledge is intentionally skipped until a later run supplies
  direct tool evidence or the user explicitly maintains it.
- Existing Skills remain editable and archivable only through an explicit normal
  agent request or the existing user-facing knowledge management flow.
- Tool evidence excludes SQL result rows, absolute counts, snapshots, and full
  SQL; those remain in run history and Vault notes.
- Re-evaluate a review queue or lifecycle metadata only if the compact,
  evidence-gated library still accumulates material duplicate or stale knowledge.
