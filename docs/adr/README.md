# Architecture Decision Records

This folder contains Architecture Decision Records (ADRs) for Stela.

## Format

Each ADR is a markdown note with YAML frontmatter. Template:

```markdown
---
type: ADR
id: "0001"
title: "Short decision title"
status: proposed        # proposed | active | superseded | retired
date: YYYY-MM-DD
superseded_by: "0007"  # only if status: superseded
---

## Context
What situation led to this decision? What forces and constraints are at play?

## Decision
**What was decided.** State it clearly in one or two sentences — bold so it stands out.

## Options considered
- **Option A** (chosen): brief description — pros / cons
- **Option B**: brief description — pros / cons

## Consequences
What becomes easier or harder as a result?
What are the positive and negative ramifications?
What would trigger re-evaluation of this decision?
```

### Status lifecycle

```
proposed → active → superseded
                 ↘ retired      (decision no longer relevant, not replaced)
```

## Rules

- One decision per file
- Files named `NNNN-short-title.md` (monotonic numbering)
- Once `active`, never edit — supersede instead
- When superseded: update `status: superseded` and add `superseded_by: "NNNN"`
- ARCHITECTURE.md reflects the current state (active decisions only)
- Agent workflow: see `AGENTS.md` and `.cursor/skills/create-adr/SKILL.md`
- Cursor auto-gates: `.cursor/hooks.json` (`sessionStart` reminder + `stop` docs check)

## Index

| ID | Title | Status |
|----|-------|--------|
| [0001](0001-electron-react-milkdown-stack.md) | Electron + React + Milkdown as application stack | active |
| [0002](0002-markdown-jsonl-as-authority.md) | Markdown + JSONL as dual authority stores | active |
| [0003](0003-disposable-sqlite-run-cache.md) | SQLite as disposable run-result cache | active |
| [0004](0004-electron-ipc-security-model.md) | Electron IPC security model with typed preload bridge | active |
| [0005](0005-connector-plugin-dual-track.md) | Connector plugin dual track (module + subprocess) | active |
| [0006](0006-runsql-detail-markdown-embedding.md) | RunSQL execution metadata embedded in Markdown via `<detail>` | active |
| [0007](0007-git-sync-over-cloud-storage.md) | Git sync instead of cloud object storage | active |
| [0008](0008-search-first-ai-instead-of-rag.md) | Search-first AI instead of on-device RAG | active |
| [0009](0009-vault-vs-machine-settings.md) | Vault-scoped vs machine-scoped settings boundary | active |
| [0010](0010-in-memory-derived-indexes.md) | In-memory derived indexes (vault-index, sql-index) | active |
| [0011](0011-openai-compatible-provider-and-fim.md) | OpenAI-compatible chat provider with separate FIM endpoint | superseded → [0015](0015-openai-compatible-provider-without-fim.md) |
| [0012](0012-dual-ai-surfaces-actions-and-agent.md) | Dual AI surfaces — action complete and harness agent | superseded → [0018](0018-pi-ai-agent-harness.md) |
| [0013](0013-agent-tools-sql-guard-and-proposals.md) | Agent tools with SQL guard and user proposal confirmation | active |
| [0014](0014-ai-context-redaction-and-schema-enrichment.md) | AI context assembly with redaction and schema enrichment | active |
| [0015](0015-openai-compatible-provider-without-fim.md) | OpenAI-compatible chat provider without FIM inline completion | superseded → [0018](0018-pi-ai-agent-harness.md) |
| [0016](0016-agent-chat-references-and-add-to-chat.md) | Agent chat references and Add to Chat | active |
| [0017](0017-user-cancelled-agent-runs.md) | User-cancelled agent runs instead of iteration limits | active |
| [0018](0018-pi-ai-agent-harness.md) | pi-ai transport and AgentHarness for AI provider and agent loop | superseded → [0023](0023-streamed-chat-sql-inline-completion.md) |
| [0019](0019-private-release-gate-patterns-via-secret.md) | Private release-gate patterns via env secret, not source | active |
| [0020](0020-parallel-readonly-agent-tools.md) | Parallel read-only agent tools; sequential for SQL and proposals | superseded → [0021](0021-parallel-agent-tools-except-propose-edit.md) |
| [0021](0021-parallel-agent-tools-except-propose-edit.md) | Parallel agent tools except propose_edit | active |
| [0022](0022-ai-multi-provider-profiles.md) | AI multi-provider profiles via pi-ai builtins + custom createProvider | active |
| [0023](0023-streamed-chat-sql-inline-completion.md) | Streamed chat-model SQL inline completion | superseded → [0024](0024-conservative-streamed-sql-inline-completion.md) |
| [0024](0024-conservative-streamed-sql-inline-completion.md) | Conservative streamed SQL inline completion | active |
| [0025](0025-quit-checkpoint-and-export-reveal.md) | Quit checkpoint feedback and restricted export reveal | active |
