---
type: ADR
id: "0032"
title: "Self-maintained internal agent knowledge Skills"
status: superseded
date: 2026-07-26
superseded_by: "0033"
---

## Context

Supersedes [ADR-0031](0031-internal-agent-knowledge-skills.md).

Stela's internal Skills prevent repeated analytical mistakes, but a static knowledge
library decays as schemas, metrics, and business terms change. Listing every Skill
metadata record in the system prompt also grows context cost linearly.

## Decision

**After each normal Agent completion, Stela runs a restricted maintenance turn that
may save, update, or archive internal data-knowledge Skills without an approval
prompt.** The maintenance turn can use only `search_skills`, `load_skill`, and
`save_skill`; `save_skill` is restricted to `.stela/skills/<name>/SKILL.md` and
`.stela/skills/.archive/`, validates a controlled category and tags, and cannot
write notes or invoke SQL.

Skill discovery is bounded: Stela ranks local metadata against the user request and
adds only the top eight candidates to the main system prompt. The Agent can use
`search_skills` to find other candidates, then `load_skill` to read one body.
Skill maintenance is reported as a compact, non-interactive Agent timeline card.

## Options considered

- **Restricted automatic maintenance with bounded discovery** (chosen): continuously
  improves durable knowledge while keeping writes and context costs bounded.
- **Manual-only Skill editing**: provides maximal human control but leaves useful
  operational knowledge unsaved and prone to decay.
- **All Skill metadata in every prompt**: simple but context use and selection
  quality degrade as a Vault accumulates Skills.

## Consequences

- The model may update Git-synced Vault content without confirmation, but only in a
  narrow dedicated directory and only through validated Markdown files.
- Archived Skills remain reviewable under `.archive/` but are excluded from
  discovery and loading.
- Categories are limited to `sql-dialect`, `metric-definition`, `business-glossary`,
  `data-lineage`, and `analysis-runbook`; tags provide domain, source, and dialect
  detail.
- Maintenance is an additional model call after successful runs, increasing latency
  and provider cost without delaying the user's primary answer.
- Re-evaluate when the library needs human review queues, retention limits, or a
  stronger provenance model.
