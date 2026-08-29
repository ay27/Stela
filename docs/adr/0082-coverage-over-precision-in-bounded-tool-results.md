---
type: ADR
id: "0082"
title: "Coverage over precision in bounded tool results"
status: active
date: 2026-08-29
---

## Context

[ADR-0078](0078-plans-as-progress-bookkeeping.md) established that correctness is
defended at the point of use: a bounded tool result must say it is incomplete
rather than pretend otherwise. It did not say **what a payload should shed first**
when it cannot fit, or **how a budget is divided between several entities in one
call**. Every tool answered those questions locally, and `get_table_schema`
answered them badly.

Across 23 vault sessions, 8 of 18 `get_table_schema` calls were truncated, in 7
different sessions. The cause was not the 30,000-character result budget:

- Structured columns stopped at a hidden `columns.length >= 80` limit in
  `parseColumnsFromDdl`, so a 329-column table reported 80 columns with no signal
  that 249 were missing.
- `ddlSnippet` consumed 63% of one 30,025-character payload while re-deriving the
  same column list from the same `SHOW CREATE TABLE`.
- Pretty-printed JSON objects cost roughly 138 characters per column, of which
  the column name and type were 30.
- The budget was spent first-come-first-served, so the first wide table consumed
  everything and the second returned a partial prefix under one global
  `...[truncated N chars]` marker that did not say which table was short.

The observed consequence is the part that matters. In two independent traces the
model read a partial column list, concluded that was the table's full width, and
computed an intersection over it. In 5 of 23 sessions it abandoned the tool and
rebuilt the column list from `information_schema`, which returned all 329 names in
11,206 characters — an order of magnitude denser than the tool it replaced. The
model's own reasoning named the reason: "schema 输出被截断了".

Two asymmetries follow from that trace evidence. A missing **comment** is a
precision loss the model can perceive and repair by asking again for named
columns. A missing **column** is a coverage loss that misrepresents the object
itself, and the model cannot perceive it, so it reasons confidently over a wrong
premise. And per [ADR-0081](0081-deterministic-tool-failure-circuit-breaker.md),
forbidding the detour in the prompt does not work; the tool has to stop being the
worse option.

## Decision

**When a bounded tool result cannot fit, shed precision before coverage, divide
the budget into equal per-entity shares rather than first-come-first-served, and
report completeness per entity rather than as one global truncation marker.**

For `get_table_schema` this means a fixed drop order of comments, then DDL, then
columns; each requested table receives `floor(budget / tables)` for its column
list; DDL spends only what column lists leave over; and every table carries
`totalColumnCount`, `returnedColumnCount`, `columnsComplete`, plus
`nextColumnOffset` and `commentsOmitted` when they apply.

Two corollaries make the order affordable:

- Comments ride along only when the caller passes `columnNames`. A named set is
  the model confirming meaning, not counting shape, and full comments plus full
  coverage never both fit for a wide table (34 characters per column bare, 60
  with a comment).
- Column lists serialize as one `name:type` line per column, not a JSON array of
  objects. Pretty-printing an array costs 12 characters of pure formatting per
  element, which alone is 8K on two 300-column tables.

Result-shape budget limits stay a property of the payload builder. A hidden
column cap inside a shared parser is not a budget; `parseColumnsFromDdl` keeps its
80-column default for prompt-embedded catalogs, and only the tool that owns a
budget raises it.

## Options considered

- **Coverage over precision, fair per-entity shares** (chosen): a wide table's
  full column list always survives; the model can name columns to recover
  comments. Costs a second call when semantics are needed for a wide table, and
  makes the payload builder responsible for its own limits instead of inheriting
  a parser's.
- **Paginate `get_table_schema`**: correct but does not address why the payload was
  four times larger than its information content, and the traces show the model
  abandons a tool rather than paging it — 8 of 9 truncated `read_note` results
  were never resumed.
- **Raise the result budget**: moves the cliff without changing the order things
  fall off it, and spends context that `run_query` results and note content also
  compete for.
- **Let the model request comments with a flag**: rejected because the same traces
  show the model inventing undeclared parameters, so a flag is not a reliable
  signal. Deriving the choice from the shape of the request needs no cooperation.
- **Forbid `information_schema` reconstruction in the prompt**: rejected on
  ADR-0081's evidence that prompt prohibitions do not change this class of
  behavior. The tool description still scopes itself as authoritative, but the
  load-bearing change is that the detour stops being cheaper.

## Consequences

Two 329-column tables now return complete in 23,737 characters where they
previously truncated at 30,025 with 80 columns each, so the detour to
`information_schema` loses its motive. A caller that needs comments for a wide
table pays a second call. A caller that needs engine, partitioning, or
distribution clauses must pass `includeDdl`, and on a wide table that snippet
arrives truncated — acceptable, because DDL is the redundant projection of data
the payload already carries losslessly.

`commentsOmitted` deliberately fires whenever comments exist but were not
included, not only when the budget forced it. A flag that only meant "the budget
squeezed them" would leave the model unable to tell a table without comments from
one whose comments it simply had not asked for.

The risk is that the truncation order is now a rule stated in one place and
implemented in another. Any new bounded payload that reverses it — dropping
entities to keep annotations — should be caught in review against this ADR;
`get_table_schema`'s 329-column regression test is the only mechanical guard, and
it guards only that tool.

Re-evaluate if a connector appears whose tables are wide enough that even bare
`name:type` lines cannot fit one table in a share, since the fair-share rule then
degrades to returning a partial prefix for every table at once. The
`nextColumnOffset` contract exists for that case but the traces give no evidence
the model will use it, which is the same unresolved question recorded for
`read_note` in the note-context-supply boundary review.
