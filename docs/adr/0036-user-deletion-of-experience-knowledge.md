---
type: ADR
id: "0036"
title: "User deletion of Experience Knowledge"
status: active
date: 2026-07-26
---

## Context

Supersedes [ADR-0035](0035-experience-knowledge-dialog.md).

Users can inspect active and archived Skills, but cannot remove incorrect or
obsolete experience knowledge without asking the Agent to do so.

## Decision

**Add a confirmed delete action for each Experience Knowledge card.** The
typed `agent.removeSkill(relativePath)` bridge accepts only a validated Skill
directory below `.stela/skills` or `.stela/skills/.archive` and moves that
directory to the operating system trash.

## Options considered

- **Confirmed trash deletion** (chosen): gives users direct cleanup while
  retaining operating-system recovery.
- **Agent-only deletion**: preserves a narrower bridge but makes user review
  incomplete.
- **Permanent deletion**: is simpler but makes a mistaken cleanup irreversible.

## Consequences

- Renderer mutation is limited to removing a listed Skill directory; arbitrary
  vault deletion remains unavailable through this bridge.
- Active and archived Skills are both removable after an explicit confirmation.
- `save_skill` remains the only Agent write tool; this UI action does not change
  Agent tool permissions.
