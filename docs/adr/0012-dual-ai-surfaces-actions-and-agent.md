---
type: ADR
id: "0012"
title: "Dual AI surfaces — action complete and harness agent"
status: superseded
superseded_by: "0018"
date: 2026-06-15
---

## Context

Users need both quick, scoped AI help (rewrite this SQL, explain this table) and longer exploratory analysis that browses schema, runs queries, and edits notes. A single chat box with no structure either under-serves one-shot edits or over-complicates them with tool loops.

## Decision

**Ship two AI surfaces that share the same provider/secrets stack:**

1. **Action complete** (`ai:complete`): one-shot request with an `AiActionKind` (rewrite-sql, ask-sql, explain-result, explain-table, …). Main builds a bounded prompt from `AiRequestContext` and returns text/SQL.
2. **Harness agent** (`ai:agent-run`): native OpenAI function-calling loop. The model drives tools; Stela supplies tools, iteration/time limits, streaming `ai:agent-event`s, and proposal gates.

Natural-language SQL search uses a third narrow path (`ai:parse-sql-query`): the model only translates the question into a `SqlIndexFilter`; hits always come from the deterministic sql-index.

## Options considered

- **Agent-only**: every ask becomes a tool loop. Too slow/noisy for rewrite-sql and schema explain. Rejected as sole surface.
- **Action-only**: cannot browse schema or verify hypotheses with live SQL. Rejected as sole surface.
- **Dual surfaces** (chosen): actions for scoped edits/explanations; agent for multi-step analysis.

## Consequences

- UI: RunSQL inline panel / AI modal for actions; `AgentSidebar` + `AgentPanel` for the harness
- `@table` mentions in the prompt input become `mentionedTables` and bias schema enrichment / agent playbook
- Agent sessions keyed by `sessionId` keep in-memory chat history across turns (not persisted)
- `parseSqlQuery` must never invent table hits — only filters
- Triggers re-evaluation if: action prompts and agent tools diverge enough to need a shared planner layer
