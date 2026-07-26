---
type: ADR
id: "0029"
title: "Vault-scoped Markdown Skills for the agent"
status: superseded
date: 2026-07-25
superseded_by: "0030"
---

## Context

Stela's `AgentHarness` can query data, search notes, and propose guarded edits, but
its procedural knowledge is currently hard-coded in the system prompt. Teams need
versioned instructions for metric definitions, analytical runbooks, and domain
gotchas, while individual users need to install their own reusable Skills.

`@earendil-works/pi-agent-core@0.80.6` already understands `SKILL.md` metadata,
discovery, and explicit Skill invocation. It does not decide where Skills live,
manage imports, or automatically expose them to an AgentHarness. Stela must retain
its vault-only filesystem and typed IPC security boundaries.

## Decision

**Store installed Agent Skills at `{vault}/.stela/skills/<skill-name>/SKILL.md`,
sync them as ordinary Vault files, and load them through pi's native `SKILL.md`
format.** The system prompt contains only each valid Skill's name, description, and
location. The model reads full content via Stela's read-only `load_skill` tool when
needed; users can explicitly run an installed Skill from the Agent Panel with
`/skill-name [instructions]`.

Imports are local-directory copies performed in main after validating the selected
folder. Skills are Markdown instructions, never executable plugins; same-name
imports are rejected rather than overwriting a Git-synced Skill.

## Options considered

- **Vault-scoped Markdown Skills** (chosen): portable, reviewable in Git, and
  directly compatible with pi's metadata; users must manage merge conflicts as
  ordinary Markdown files.
- **Machine-scoped Skills**: avoids sharing personal instructions but splits
  team knowledge from the Vault and weakens reproducibility.
- **Remote marketplace or Git URL installation**: convenient discovery but adds
  network, version, provenance, and update-policy surfaces that are unnecessary
  for the initial local-first release.

## Consequences

- Skill instructions become part of the Vault's trusted collaborative content:
  importing a Skill can influence model behavior, but cannot execute code or
  bypass the existing SQL/edit approval gates.
- Invalid metadata is visible in Settings diagnostics and excluded from Agent use.
- Discovery runs per Agent request, so manual edits, imports, and Git pulls take
  effect immediately without cache invalidation.
- Explicit slash commands use pi's `harness.skill()` flow; autonomous model use
  reads the selected Skill through `load_skill` in the current tool loop.
- Re-evaluate when users need remote installation, signed provenance, per-Skill
  access control, or cross-Vault personal Skill overlays.
