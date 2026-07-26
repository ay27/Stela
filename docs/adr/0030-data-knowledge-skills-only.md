---
type: ADR
id: "0030"
title: "Data-knowledge Skills only"
status: superseded
date: 2026-07-26
superseded_by: "0031"
---

## Context

Supersedes [ADR-0029](0029-vault-scoped-agent-skills.md).

Stela is a data-analysis agent with guarded SQL, schema, and Vault-note tools. A
generic external Agent Skill may require shell execution, network access, browsers,
or arbitrary code. Treating pi-compatible Markdown as a promise that Stela can run
the Skill creates misleading UX and pressure to expand the application's trust
boundary.

## Decision

**Skills are Vault-maintained data knowledge and analysis instructions only.**
They live at `{vault}/.stela/skills/<skill-name>/SKILL.md`, are edited and reviewed
as normal Git-synced Vault content, and guide the agent's existing data tools.
Stela does not import external Skill directories or offer a generic Skill installer.

## Options considered

- **Data-knowledge Skills only** (chosen): preserves a small, auditable tool
  surface and makes Skills useful for metrics, definitions, table routing, and
  analytical runbooks.
- **Generic local Skill import**: superficially convenient, but imports
  instructions that frequently rely on capabilities Stela intentionally lacks.
- **General-purpose plugin runtime**: would require a new execution and trust model,
  outside Stela's data-agent scope.

## Consequences

- Settings can list Skills and diagnostics, but users create or edit them directly
  in the Vault rather than installing packages.
- `load_skill` and `/skill-name` continue to load only valid local knowledge.
- New execution capabilities require their own explicit product and security
  decision; Skills cannot silently broaden agent permissions.
