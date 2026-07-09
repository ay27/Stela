---
type: ADR
id: "0013"
title: "Agent tools with SQL guard and user proposal confirmation"
status: active
date: 2026-06-20
---

## Context

The harness agent can list schemas, run SQL, search the vault, and edit notes. Unrestricted tool use would let a model mutate databases or overwrite Markdown without review. Stela already has connector execute + vault FS; the agent should reuse those with explicit safety rails.

## Decision

**Agent tools are thin dispatchers over existing services**, with two hard gates:

1. **SQL guard** (`sql-guard.ts`): classify statements as read-only / mutation / multi-statement. Read-only runs immediately (row limits enforced by core `sql-limit`). Multi-statement is always blocked. Mutations require `agentAllowMutations` **and** an explicit user approve via proposal IPC.
2. **Proposal confirmation**: `run_sql` (mutations) and `propose_edit` never write directly. They emit `AgentEvent.proposal`, block the tool Promise until `ai:agent-respond-proposal`, then continue or fail.

Tool set: `list_databases`, `list_tables`, `search_tables`, `get_table_schema`, `run_sql`, `search_vault`, `list_vault_files`, `read_note`, `propose_edit`.

## Options considered

- **Fully autonomous writes**: fastest agent UX, unacceptable data-loss risk. Rejected.
- **Read-only agent forever**: safest, but cannot apply SQL/note fixes the user asked for. Rejected.
- **Guarded tools + proposal UX** (chosen): model proposes; human confirms; defaults keep mutations off.

## Consequences

- Iteration capped by `agentMaxIterations` and `agentWallClockMs`
- Tool results truncated before re-entering the model context
- SQL classification is keyword-heuristic, not a full parser — complex dynamic SQL may misclassify
- Note edits support full replace or single exact `oldText`→`newText` patch for long files
- Triggers re-evaluation if: users need sandboxed auto-apply for trusted vaults, or SQL guard false positives become common
