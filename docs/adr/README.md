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
| [0013](0013-agent-tools-sql-guard-and-proposals.md) | Agent tools with SQL guard and user proposal confirmation | superseded → [0066](0066-structured-read-only-agent-queries.md) |
| [0014](0014-ai-context-redaction-and-schema-enrichment.md) | AI context assembly with redaction and schema enrichment | superseded → [0059](0059-agent-panel-quick-actions.md) |
| [0015](0015-openai-compatible-provider-without-fim.md) | OpenAI-compatible chat provider without FIM inline completion | superseded → [0018](0018-pi-ai-agent-harness.md) |
| [0016](0016-agent-chat-references-and-add-to-chat.md) | Agent chat references and Add to Chat | superseded → [0061](0061-ordered-inline-agent-message-resources.md) |
| [0017](0017-user-cancelled-agent-runs.md) | User-cancelled agent runs instead of iteration limits | active |
| [0018](0018-pi-ai-agent-harness.md) | pi-ai transport and AgentHarness for AI provider and agent loop | superseded → [0023](0023-streamed-chat-sql-inline-completion.md) |
| [0019](0019-private-release-gate-patterns-via-secret.md) | Private release-gate patterns via env secret, not source | active |
| [0020](0020-parallel-readonly-agent-tools.md) | Parallel read-only agent tools; sequential for SQL and proposals | superseded → [0021](0021-parallel-agent-tools-except-propose-edit.md) |
| [0021](0021-parallel-agent-tools-except-propose-edit.md) | Parallel agent tools except propose_edit | active |
| [0022](0022-ai-multi-provider-profiles.md) | AI multi-provider profiles via pi-ai builtins + custom createProvider | active |
| [0023](0023-streamed-chat-sql-inline-completion.md) | Streamed chat-model SQL inline completion | superseded → [0024](0024-conservative-streamed-sql-inline-completion.md) |
| [0024](0024-conservative-streamed-sql-inline-completion.md) | Conservative streamed SQL inline completion | superseded → [0028](0028-inline-completion-schema-and-note-context.md) |
| [0025](0025-quit-checkpoint-and-export-reveal.md) | Quit checkpoint feedback and restricted export reveal | active |
| [0026](0026-ranked-lexical-retrieval-for-agent.md) | Ranked lexical retrieval for agent tools | active |
| [0027](0027-agent-ask-user-clarification.md) | Agent clarification questions as a third proposal kind | active |
| [0028](0028-inline-completion-schema-and-note-context.md) | Inline completion reads renderer column cache and note context | active |
| [0029](0029-vault-scoped-agent-skills.md) | Vault-scoped Markdown Skills for the agent | superseded → [0030](0030-data-knowledge-skills-only.md) |
| [0030](0030-data-knowledge-skills-only.md) | Data-knowledge Skills only | superseded → [0031](0031-internal-agent-knowledge-skills.md) |
| [0031](0031-internal-agent-knowledge-skills.md) | Internal agent knowledge Skills | superseded → [0032](0032-self-maintained-agent-knowledge-skills.md) |
| [0032](0032-self-maintained-agent-knowledge-skills.md) | Self-maintained internal agent knowledge Skills | superseded → [0033](0033-explicit-and-automatic-skill-maintenance.md) |
| [0033](0033-explicit-and-automatic-skill-maintenance.md) | Explicit and automatic Skill maintenance | superseded → [0037](0037-concise-verified-skill-maintenance.md) |
| [0034](0034-read-only-experience-knowledge-library.md) | Read-only Experience Knowledge library | superseded → [0035](0035-experience-knowledge-dialog.md) |
| [0035](0035-experience-knowledge-dialog.md) | Experience Knowledge dialog | superseded → [0036](0036-user-deletion-of-experience-knowledge.md) |
| [0036](0036-user-deletion-of-experience-knowledge.md) | User deletion of Experience Knowledge | active |
| [0037](0037-concise-verified-skill-maintenance.md) | Concise verified Skill maintenance | superseded → [0043](0043-evidence-gated-skill-maintenance.md) |
| [0038](0038-runtime-agent-execution-plans.md) | Runtime linear agent execution plans | superseded → [0060](0060-cache-stable-agent-prompts.md) |
| [0039](0039-concise-agent-final-answers.md) | Concise agent final answers | active |
| [0040](0040-native-vault-watcher-backend.md) | Native vault watcher backend | active |
| [0041](0041-agent-live-schema-authority.md) | Agent live schema authority | active |
| [0042](0042-connector-describe-tables-api.md) | Connector describeTables API for live column COMMENT | active |
| [0043](0043-evidence-gated-skill-maintenance.md) | Evidence-gated Skill maintenance | superseded → [0044](0044-associative-skill-distillation.md) |
| [0044](0044-associative-skill-distillation.md) | Associative Skill distillation | superseded → [0045](0045-recency-ordered-skill-distillation.md) |
| [0045](0045-recency-ordered-skill-distillation.md) | Recency-ordered Skill distillation | superseded → [0050](0050-source-tracked-template-driven-skills.md) |
| [0046](0046-device-sharded-agent-session-history.md) | Device-sharded Agent session history | active |
| [0047](0047-bounded-device-agent-history-retention.md) | Bounded device Agent history retention | active |
| [0048](0048-vault-markdown-sql-template-library.md) | Vault Markdown SQL template library | active |
| [0049](0049-independent-bounded-skill-maintenance.md) | Independent bounded Skill maintenance | active |
| [0050](0050-source-tracked-template-driven-skills.md) | Source-tracked template-driven Skills | active |
| [0051](0051-local-agent-observability-store.md) | Local Agent observability store | superseded → [0052](0052-signal-focused-agent-observability.md) |
| [0052](0052-signal-focused-agent-observability.md) | Signal-focused Agent observability | active |
| [0053](0053-declarative-result-bound-analytical-charts.md) | Declarative result-bound analytical charts | superseded → [0054](0054-runsql-owned-analytical-charts.md) |
| [0054](0054-runsql-owned-analytical-charts.md) | RunSQL-owned analytical charts | superseded → [0055](0055-vault-analysis-canvas-artifacts.md) |
| [0055](0055-vault-analysis-canvas-artifacts.md) | Vault analysis Canvas artifacts | superseded → [0056](0056-user-adjustable-react-flow-cards.md) |
| [0056](0056-user-adjustable-react-flow-cards.md) | User-adjustable React Flow cards | active |
| [0057](0057-bounded-mark-encoding-visualizations.md) | Bounded mark-encoding visualizations | active |
| [0058](0058-offline-interactive-canvas-html-export.md) | Offline interactive Canvas HTML export | active |
| [0059](0059-agent-panel-quick-actions.md) | Agent Panel quick actions instead of one-shot AI actions | active |
| [0060](0060-cache-stable-agent-prompts.md) | Cache-stable Agent prompts and immutable plan snapshots | active |
| [0061](0061-ordered-inline-agent-message-resources.md) | Ordered inline Agent message resources | superseded → [0062](0062-implicit-workspace-context-explicit-inline-resources.md) |
| [0062](0062-implicit-workspace-context-explicit-inline-resources.md) | Implicit Workspace context and explicit inline resources | active |
| [0063](0063-prosemirror-agent-composer.md) | ProseMirror-backed Agent composer | active |
| [0064](0064-session-query-artifacts-and-sandboxed-python.md) | Session query artifacts and sandboxed Python | active |
| [0065](0065-session-oriented-agent-observability.md) | Session-oriented Agent observability projection | active |
| [0066](0066-structured-read-only-agent-queries.md) | Structured read-only Agent queries across connector languages | superseded → [0067](0067-safe-mongodb-aggregation-queries.md) |
| [0067](0067-safe-mongodb-aggregation-queries.md) | Safe MongoDB aggregation queries | active |
| [0068](0068-headless-pyodide-agent-evaluation.md) | Headless Pyodide Agent evaluation | active |
