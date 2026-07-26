---
type: ADR
id: "0031"
title: "Internal agent knowledge Skills"
status: superseded
date: 2026-07-26
superseded_by: "0032"
---

## Context

Supersedes [ADR-0030](0030-data-knowledge-skills-only.md).

Vault Skills are internal instructions that improve the agent's use of Stela data
tools. Listing them in Settings and exposing slash commands makes an implementation
detail into a user-facing workflow, despite there being no supported installation or
authoring surface.

## Decision

**Keep Vault Skills entirely behind the agent.** The agent discovers valid
`.stela/skills/<skill-name>/SKILL.md` files per run and uses `load_skill` on demand;
Settings, IPC, preload APIs, diagnostics, and explicit `/skill-name` invocation are
not exposed to users.

## Options considered

- **Internal agent knowledge** (chosen): keeps the product focused on analysis
  outcomes and preserves the existing minimal agent-tool boundary.
- **Visible management and slash invocation**: offers explicit control, but exposes
  an unsupported Skill lifecycle and creates terminology users do not need.

## Consequences

- Skills remain Git-reviewable Vault content, but their discovery errors are not
  surfaced in the product UI.
- Users cannot force a particular Skill for an individual run; model selection is
  constrained to the available internal knowledge list.
- A future authoring or governance workflow may revisit visibility with a complete
  lifecycle instead of exposing raw files and commands.
