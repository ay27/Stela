---
type: ADR
id: "0033"
title: "Explicit and automatic Skill maintenance"
status: active
date: 2026-07-26
---

## Context

Supersedes [ADR-0032](0032-self-maintained-agent-knowledge-skills.md).

Automatic maintenance should not turn a one-off product demonstration into a
domain Skill. However, users must be able to explicitly ask the Agent to retain
verified reusable knowledge during a normal conversation. Restricting `save_skill`
to the post-run maintenance turn prevents that intentional workflow.

## Decision

**Expose `save_skill` to both normal and maintenance Agent turns.** Normal Agent
turns use it only for an explicit user request to remember, create, update, or retire
verified reusable data knowledge. The post-run maintenance turn retains autonomous
use for durable knowledge discovered during normal analysis.

Both paths retain the same `.stela/skills`-only path boundary, frontmatter
validation, category/tags contract, size limit, sequential execution, archive
behavior, and timeline audit. `propose_edit` remains for user notes and cannot create
or modify Skills.

## Options considered

- **Explicit plus automatic writes** (chosen): supports intentional retention while
  keeping the automatic path conservative.
- **Automatic-only writes**: avoids direct Agent writes but makes a user request to
  record knowledge impossible in the current turn.
- **Note-edit proposals for Skills**: preserves approval UI but duplicates the Skill
  storage contract and defeats the dedicated write boundary.

## Consequences

- A clear user request can cause an immediate, auditable Skill write without a
  confirmation dialog.
- Normal prompts must distinguish reusable data knowledge from notes, and must not
  suggest `propose_edit` for Skills.
- The existing confinement is the security boundary; future broader write targets
  need a separate decision.
