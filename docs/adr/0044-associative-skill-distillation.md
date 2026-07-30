---
type: ADR
id: "0044"
title: "Associative Skill distillation"
status: superseded
superseded_by: "0045"
date: 2026-07-30
---

## Context

Supersedes [ADR-0043](0043-evidence-gated-skill-maintenance.md).

Evidence-gated maintenance prevents unsupported writes, but a single completed
turn can still produce a narrow rule that conflicts with prior uses of the same
table. It also has no reliable basis for assigning a connector dialect tag.

## Decision

**Automatic Skill maintenance may perform bounded associative retrieval from
tables extracted from the current run's SQL evidence.** It can query indexed
read/write usage only for those tables and read at most three returned notes;
it creates a Skill only from cross-record rules and remains create-only.

**Automatic writes reject known dialect tags that conflict with the active
connection dialect.** The live schema continues to override retained knowledge.

## Options considered

- **Evidence-scoped associative retrieval** (chosen): adds corroborating context
  without granting broad Vault search or live connector access.
- **Prompt-only evidence interpretation**: cheaper but repeats local,
  over-specific conclusions.
- **Unrestricted Vault retrieval or a vector store**: broadens data exposure and
  adds indexing complexity beyond the small targeted need.

## Consequences

- Maintenance skips a candidate when related SQL records are absent or conflict.
- The maintenance agent cannot discover unrelated tables, read arbitrary notes,
  run SQL, overwrite, or archive Skills.
- A missing or unrecognised dialect leaves tags ungated; it never authorizes a
  guessed dialect tag.
