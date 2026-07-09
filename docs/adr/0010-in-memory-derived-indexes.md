---
type: ADR
id: "0010"
title: "In-memory derived indexes (vault-index, sql-index)"
status: active
date: 2026-05-10
---

## Context

Stela needs wikilink resolution, backlink navigation, and structured SQL search across the vault. Persisting indexes to disk (as in the v0.4 knowledge-base design) creates a third store to keep in sync, increases startup complexity, and duplicates information already present in Markdown and `<detail>` metadata.

## Decision

**Vault-index and sql-index are in-memory derived indexes**, rebuilt on vault open and incrementally updated by the vault watcher. They are never written to disk and never enter Git. A full rebuild is always possible by rescanning Markdown files.

## Options considered

- **SQLite knowledge base** (v0.4 RAG): persistent FTS + vector index. Removed with RAG (ADR-0008).
- **On-disk JSON index**: faster startup, but stale-index bugs and sync complexity. Rejected.
- **In-memory only** (chosen): simplest consistency model; acceptable for vaults up to thousands of files.

## Consequences

- `vault-index.ts`: titles, headings, outgoing `[[wikilinks]]`, backlinks — powers wiki autocomplete and link panel
- `sql-index.ts`: AST-extracted table/column facts from `runsql` blocks — powers `SqlSearchView` and AI context
- Watcher events (`added`/`changed`/`removed`) trigger incremental updates; `index:changed` / `sql-index:changed` notify renderer
- Vault switch discards old indexes entirely — no cross-vault leakage
- Large vaults pay rescan cost on open — acceptable for target scale (< 5k files)
- Triggers re-evaluation if: vault scale exceeds in-memory rebuild budget (seconds on open), requiring persistent incremental index files
