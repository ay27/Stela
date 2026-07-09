---
type: ADR
id: "0008"
title: "Search-first AI instead of on-device RAG"
status: active
date: 2026-05-01
---

## Context

Stela v0.4 explored on-device RAG: embedding models (Xenova/multilingual-e5-small), sqlite-vec vector store (`.stela-knowledge.sqlite`), and an MCP server child for external LLM clients. This added ~110MB model downloads, onnxruntime native dependencies, complex index lifecycle, and packaging gates that conflicted with open-source distribution goals.

## Decision

**Remove on-device embedding/RAG from the open-source release.** AI features use a **search-first** context model: vault full-text search, SQL fact index (AST extraction), schema browser metadata, and optional redacted result samples. Inline completion (FIM) and a harness agent with function-calling serve in-app AI. API keys stay in main process.

## Options considered

- **On-device RAG** (v0.4 internal): zero API cost for retrieval, but heavy deps, slow first-run, packaging complexity. Removed from OSS.
- **Cloud-only RAG** (embed via API): simpler packaging, but sends vault content to embedding API. Rejected for privacy posture.
- **Search-first + optional cloud LLM** (chosen): no embedding runtime; retrieval uses existing indexes; user controls what context leaves the machine.
- **No AI**: simplest, but loses competitive differentiation. Rejected.

## Consequences

- `check-public-release.mjs` blocks onnxruntime, transformers.js, sqlite-vec, MCP SDK
- AI settings: `providerMode`, `sendResultSamples`, `maxSampleRows` give user control
- Agent mutations require explicit user confirmation (proposal flow)
- MCP server and knowledge base docs from internal v0.4 are not shipped in OSS
- Semantic search panel removed; `SqlSearchView` + vault search + AI agent cover retrieval
- Follow-on decisions: [ADR-0011](0011-openai-compatible-provider-and-fim.md) (provider/FIM), [ADR-0012](0012-dual-ai-surfaces-actions-and-agent.md) (action vs agent), [ADR-0013](0013-agent-tools-sql-guard-and-proposals.md) (tools/guard), [ADR-0014](0014-ai-context-redaction-and-schema-enrichment.md) (context/redaction)
- Triggers re-evaluation if: lightweight on-device embeddings become viable without native deps, or users demand MCP integration in OSS
