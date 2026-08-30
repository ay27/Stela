---
type: ADR
id: "0083"
title: "Sourced read-only System Skills"
status: active
date: 2026-08-29
---

## Context

Stela's stable Agent prompt and provider-facing tool schemas are paid and attended
on every new run. Some instructions are neither global safety policy nor
user-maintained data knowledge: they are detailed methods for using one Stela
capability, such as the cross-field rules for `create_chart`. Keeping those rules
in the system prompt or JSON Schema makes every analysis carry them even when the
capability is never used.

Existing Skills are Vault-owned knowledge. They are ranked from the request,
tracked against Vault sources, maintained by the Agent, shown in Experience
Knowledge, and removable by the user. Tool-authoring guidance has a different
authority and lifecycle, so placing it in the Vault Skill namespace without a
source boundary would let a Vault file shadow application behavior or enter the
maintenance pipeline.

pi-agent-core already provides `loadSourcedSkills`, which attaches an
application-defined source to every loaded Skill and diagnostic. A second loader
or a second model tool would duplicate that mechanism and enlarge the fixed tool
surface.

## Decision

**Stela loads bundled read-only System Skills and Vault Skills through
pi-agent-core's `loadSourcedSkills`, preserves `system` or `vault` provenance in
runtime metadata, and uses the existing `load_skill` tool for exact loading of
either source.**

System Skills live in `resources/playbooks/<name>/SKILL.md`, ship as Electron
extra resources, and are loaded before `{vault}/.stela/skills`. They are
application guidance and a successful `load_skill` result identifies them with
`source=system`. They are not business facts and never override the user's goal,
the tool validator, live schema, or successful query results.

The source boundary is enforced as follows:

- System Skills are excluded from prompt ranking, `search_skills`, freshness
  checks, automatic or explicit maintenance, and the Experience Knowledge UI.
- A System Skill can be reached only by an exact `load_skill` name stated by a
  relevant capability, such as `create_chart` naming `chart-authoring`.
- `save_skill` and archive operations reject System Skill names. A Vault Skill
  whose name collides with a loaded System Skill is rejected rather than
  shadowing it.
- System Skill validation checks the pi name/description contract, the Stela
  size limit, and a non-empty body. Vault-only category, tags, provenance, and
  maintenance templates do not apply.

## Options considered

- **Sourced Skills with one exact-load tool** (chosen): reuses pi's provenance
  primitive, keeps task-specific methods out of the stable prompt, and adds no
  provider-facing tool. It requires explicit source guards at every Vault write
  and discovery boundary.
- **Keep capability methods in tool descriptions**: simplest runtime, but makes
  large conditional rule matrices permanent context and was the source of the
  prompt/schema growth this decision addresses.
- **Add a separate `load_playbook` tool and registry**: makes the distinction
  visible in the API, but duplicates pi loading and spends fixed schema tokens
  for a distinction the returned source field already carries.
- **Store bundled methods as Vault Skills**: reuses current UI and maintenance,
  but gives application-owned behavior a user-owned lifecycle and permits
  accidental or hostile shadowing.

## Consequences

The stable prompt needs one narrow trust exception: ordinary tool results remain
untrusted data, while a successful `load_skill` result with `source=system` is
Stela-provided task guidance. The first bundled Skill is `chart-authoring`; it
holds preset/mark/channel/format composition rules while the `create_chart`
schema retains structural fields and legal enum values.

Missing or invalid bundled Skills are reported separately from Vault diagnostics
and make the named capability guidance unavailable, but do not prevent the app
from starting. New System Skills must have a deterministic point-of-use trigger;
they should not create a second ambient ranking system.

Re-evaluate if System Skills need user-selectable versions or capability
negotiation. That would require an explicit product contract rather than adding
frontmatter fields speculatively.
