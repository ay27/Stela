---
type: ADR
id: "0034"
title: "Read-only Experience Knowledge library"
status: superseded
superseded_by: "0035"
date: 2026-07-26
---

## Context

Agent-maintained Skills are intentionally bounded and stored in the vault, but
their existence and retirement state are otherwise difficult for a user to
inspect. The previous internal-only surface prevents users from reviewing the
knowledge persisted alongside their notes.

## Decision

**Expose a read-only vault-scoped Skill list through the bottom-bar Experience
Knowledge popover.** The typed `agent.listSkills()` preload method returns only
name, description, category, tags, relative path, and active/archived status.

## Options considered

- **Bottom-bar read-only library** (chosen): provides quick inspection without
  creating another settings surface or a mutation path.
- **Hide Skills entirely**: keeps the interface smaller but makes persisted
  knowledge and retirement opaque.
- **Full Skill management UI**: enables direct edits but duplicates the
  validated Agent write boundary and broadens the product scope.

## Consequences

- Users can audit active and retired experience knowledge in the current vault.
- The renderer receives no Skill body and cannot create, update, or archive a
  Skill; `save_skill` remains the only write capability.
- The list is loaded on demand, so it does not add startup work or Agent context.
