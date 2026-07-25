---
type: ADR
id: "0026"
title: "Ranked lexical retrieval for agent tools"
status: active
date: 2026-07-25
---

## Context

Extends [ADR-0008](0008-search-first-ai-instead-of-rag.md) (search-first, no RAG)
and [ADR-0010](0010-in-memory-derived-indexes.md) (in-memory derived indexes).
Neither is overturned: retrieval stays purely lexical, in-process, and free of
embeddings.

Measuring a real vault (1445 notes, 913 `db.table.md` schema docs, 1142 RunSQL
blocks, 8881 recorded runs, 5.7 MB of body text) showed the agent's retrieval
tools failing for reasons unrelated to relevance:

- `schema-context` stopped after the first 500 schema files in `readdir` order,
  so 45% of the tables could not be found at all.
- DDL `COMMENT` text — the only place Chinese business vocabulary exists, present
  in 925 notes, mostly as StarRocks double-quoted comments — was only visible as
  part of the raw DDL snippet, scoring the same weak `+3` as a type name.
- The tokenizer split on Unicode letter runs, so a Chinese query produced one
  long unsplittable token and matched almost nothing.
- `searchVault` returned as soon as it had filled its hit budget, meaning the
  result set was determined by directory traversal order; multi-keyword queries
  divided that budget per keyword, letting an irrelevant keyword starve the best
  note.
- `sql-index.query()` truncated to `maxHits` in `docId` order for the same
  reason, and the agent had no tool to reach the index at all despite it already
  holding exact table→block facts.

Evaluation harness and iron rule for it: **no signal used to produce gold labels
may enter the ranker.** Labels are mechanically derived (M1 table identifier →
notes from SQL AST facts; M2 Chinese heading → tables from the same section's
blocks; M3 negatives), never LLM- or hand-authored.

## Decision

**Rank lexical retrieval over the whole vault on every query, aggregate note results at note level, expose the SQL index to the agent, and keep execution history out of scoring.**

- Scan the entire vault, then sort, then truncate. `searchVaultNotes` returns
  note-level hits (`path`, `title`, `score`, `matchCount`, `matchedKeywords`,
  `matchedHeadings`, `bestSnippet`) plus `scannedNotes / totalMatchedNotes /
  returned / truncated` so the model can tell a narrow result from a truncated
  one. Weights: title or path 40, heading 12 (max 3 per keyword), body line 1
  (max 10 per keyword), multiplied by the number of distinct keywords matched.
  `searchVault` keeps its line-level shape for the UI.
- `parseColumnsFromDdl` extracts `COMMENT '…'` and `COMMENT "…"` into a
  structured `comment` field per column, and column types stop at the first
  modifier. Table scoring: table name 16, column name 8, column comment 6, DDL
  fallback 1.
- Tokenization expands CJK runs into overlapping bigrams so Chinese business
  terms match at all. `MAX_SCHEMA_FILES` is 5000.
- Add the `search_sql_usage` agent tool, calling `sql-index` in-process (no new
  IPC channel), and sort `sql-index.query()` by `runDate` descending before
  truncating.
- Execution history stays out of ranking. Agent `run_sql` now records to
  `result-store` and `history-journal` under `blockId` `agent:<runId>`, and
  `search_tables` reports per-candidate `vaultUsage` (notes, blocks, last run
  date) as **tool output the model reads**, not as a score term. M2 gold labels
  correlate with usage, so scoring on it would flatter the metric.
- FTS5 is evaluated and deferred: 5.7 MB of text scans far faster than one LLM
  call, and CJK would need a trigram tokenizer for limited gain. Upgrade path if
  the corpus grows an order of magnitude or scan latency becomes visible: build
  an FTS5 table beside the disposable run cache from ADR-0003, keeping Markdown
  authoritative per ADR-0002.

## Options considered

- **Ranked full scan** (chosen): one pass, no index to invalidate, no new
  dependency; cost grows linearly with vault size.
- **SQLite FTS5 index**: sublinear queries and BM25 for free, but a new
  index to keep in sync, a CJK tokenizer problem, and no measurable win at
  6 MB. Deferred.
- **Embeddings / RAG**: rejected by ADR-0008 and by the open-source release
  gate.
- **Frecency as a ranking term**: attractive, but M2's gold labels come from
  the same sections whose blocks produce the run history, so gains would be
  partly self-inflicted. Exposed as tool output instead.

## Consequences

- Every keyword search reads all `.md` bodies; scan time is proportional to
  vault size and shows in tool latency for very large vaults.
- Measured on the real vault: M1 recall@20 78.2% → 91.0% with miss rate 2.9% →
  0%; M2 recall@20 3.3% → 27.3%, MRR +17.4pp. Negative queries still return
  zero false positives.
- The model now sees usage statistics it must interpret; a bad prompt could make
  it over-trust popularity.
- Agent-executed SQL becomes part of run history and Git-visible journals, which
  is the point, but it also means agent activity shows up in the same history as
  user runs (distinguished by the `agent:` block prefix).
- Re-evaluate when vault text exceeds roughly 50 MB, when scan latency becomes
  user-visible, or if ranking without frecency proves insufficient on a corpus
  where labels and usage can be decorrelated.
