---
type: ADR
id: "0088"
title: "Configurable automatic Agent edits"
status: active
date: 2026-09-03
---

## Context

Supersedes [ADR-0059](0059-agent-panel-quick-actions.md).

ADR-0059 unified scoped AI actions in the Agent Panel and required explicit
approval before applying every note or RunSQL rewrite. The target binding,
preview, and proposal audit are still useful safety boundaries, but requiring a
click for every low-risk edit interrupts common workflows. Database mutations
and Agent questions carry different authority and must remain explicit user
decisions.

## Decision

**Add a vault-scoped `agentAutoApplyEdits` setting, defaulting to `false`. When
enabled, `propose_edit` requests for `edit_note` and `runsql_rewrite` resolve
automatically through the existing proposal channel. `mutation_sql` and
`question` proposals always remain manual.**

Main snapshots the setting when a run starts and marks each proposal event with
`approvalMode: "manual" | "automatic"`. The renderer sends the existing
`ai:agent-respond-proposal` response automatically only for eligible edit
proposals. Proposal events, responses, history, and metrics remain observable.

Automatic mode does not bypass edit validation. Note writes still use the
vault-bounded path and read-back checks. RunSQL rewrites still require the exact
renderer-owned target and original SQL snapshot before the inline edit is
applied. If an automatic response fails, the proposal falls back to manual UI;
a missing or stale RunSQL target is rejected.

## Options considered

- **Configurable automatic edits** (chosen): reduces interruption while keeping
  the existing target checks, audit trail, and manual default.
- **Always require approval**: minimizes accidental edits but preserves the
  high-frequency confirmation cost.
- **Always apply every proposal automatically**: simplest interaction, but
  would incorrectly grant database mutation and question authority.

## Consequences

- Existing vaults keep explicit approval until the user enables the setting.
- Users can opt into automatic note and RunSQL edits without weakening mutation
  or clarification safeguards.
- Git/history and the proposal timeline remain the recovery and audit paths.
- A run uses the setting snapshot captured at start; changing it affects later
  runs, not proposals already in flight.
- Re-evaluate if automatic edits need finer per-note, per-connection, or
  per-workspace policy.
