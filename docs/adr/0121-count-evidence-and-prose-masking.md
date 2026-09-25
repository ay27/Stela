---
type: ADR
id: "0121"
title: "Count expression evidence and numeric prose boundaries"
status: active
date: 2026-09-25
---

## Context

ADR-0118 preserves proven counts, but the initial recognizer only accepted one
COUNT without WHERE/GROUP BY. Connectors can return every cell as VARCHAR, so
even those counts were masked. Learning query values such as 0 and 1 also caused
global replacements inside protocol versions, percentages and formatted numbers.

## Decision

**Preserve nonnegative integer cells proven to be counts by their SELECT
expression, including string-encoded counts. Limit numeric known-value
replacement in prose to complete long integers.**

Reuse the existing local SQL parser; require one error-free SELECT, an exact
projection-to-column alignment, no wildcard expansion, no CTE/subquery/set
operation and no comments. Recognize direct COUNT(*)/COUNT(identifier)/COUNT
(DISTINCT identifier), and SUM of a single CASE WHEN with literal 0/1 branches.
WHERE, GROUP BY, ORDER BY and LIMIT do not change the count expression's role.
Aliases alone never authorize a cell. Unrecognized expressions, window functions,
arithmetic, SUM/AVG/MIN/MAX of data, identifiers and JSON leaves remain masked.

In free prose, do not globally replace learned decimals or integers shorter than
seven digits. Match long integers as complete numbers, not parts of decimals,
thousands separators or other identifiers. Data-cell masking remains unchanged;
this is an explicit prose coverage limitation, not a safe-ID classifier. Phone
and email detection remains local. Grants and model projection are unchanged.

## Options considered

- **Expression evidence and bounded prose matching (chosen):** reduces unnecessary
  approvals while avoiding alias-based numeric authorization and protocol damage.
- Preserve all numeric columns or aggregate-looking aliases: can expose IDs.
- Replace every learned number everywhere: corrupts unrelated instructions and
  numeric facts; a shared spelling does not establish the same data provenance.

## Consequences

Grouped counts and null-count indicators work without release. Category labels
and other aggregates may still require approval. This does not implement general
SQL lineage or infer business intent. Counts remain data minimization, not a
defense against malicious SQL encoding. Raw short numeric identifiers in prose
are outside full data-cell coverage and require a future typed input boundary.
