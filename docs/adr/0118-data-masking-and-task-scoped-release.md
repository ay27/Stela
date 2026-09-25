---
type: ADR
id: "0118"
title: "Data masking with task-scoped column release"
status: active
date: 2026-09-25
---

## Context

Supersedes [ADR-0117](0117-local-ai-privacy-mode.md).

Entity recognition misses business names and numeric identifiers. Arbitrary SQL
expressions and JSON data cannot be classified reliably from aliases or samples.
Users need predictable offline protection and an explicit way to permit semantic
analysis of selected data. Python must observe the same boundary.

## Decision

**Mask all query text and unknown numeric cells locally; release selected source
columns or JSON paths only after a manual, task-scoped user decision. Remove the
argus-redact runtime. Main owns the policy, mappings, grants and model projection.**

- Keep nulls and booleans. Preserve numeric counts only for a deliberately narrow,
  validated SQL shape. Other numeric cells are unknown, not declared sensitive.
  Names, digit lengths and uniqueness never authorize plaintext. JSON string
  leaves and numbers use the same policy. Objects/arrays retain structure; keys
  outside a conservative structural identifier convention are masked. This key
  convention is heuristic, not a schema or a guarantee about sensitive keys.
- Preserve protocol identifiers, query metadata and instructions. Free prose uses
  local phone/email patterns and known identity replacement; arbitrary names in
  user prose, schema names/comments or instructions are outside the all-cell
  guarantee. Credentials remain irreversibly redacted.
- Grants bind to an immutable result run ID, column ordinal and optional JSON path
  segments (array wildcard only). No global original-value whitelist. Preview
  values are local UI only. Whole-column release is explicit, including JSON.
- Reuse the typed proposal channel with a dedicated manual privacy proposal and
  exact option IDs encoded in its answer. Unselected, rejected, aborted, expired
  or malformed responses release nothing. Explain recipients and task lifetime.
- Persist masked tool history. Only Main-registered tool-call outputs receive a
  temporary plaintext projection at transport dispatch. The projection matches
  exact call ID, tool name and masked payload. It is not a model-controlled flag.
- Python consumes complete sanitized artifacts; selected cells may be raw after
  approval. Reuse the exact source run ID, never copy grants to a new query.
  Grant changes rebuild its workspace and invalidate artifact caches. Derived
  Python output and semantic requests can contain approved data; these are
  trusted only because all source bytes crossed this input boundary. Mapping
  state is never sent to Python. End-of-task disposal expires grants and clears
  Python state; durable history remains masked. Sent data cannot be recalled.
- Retain conversation-scoped random mappings and local display restoration from
  ADR-0117. Saved conversation maps still follow Git and are not encryption.

## Options considered

- **Default masking plus explicit release (chosen):** predictable cell coverage,
  offline and no model downloads; more approval friction and token overhead.
- NER or column classifiers: useful suggestions but cannot authorize transmission
  safely; names and samples are insufficient for arbitrary dynamic SQL.
- Global value exemptions: easy to implement but leak the same value from a
  different source and persist permissions beyond the approved task.

## Consequences

String operations and arithmetic on unknown numeric columns require approval or
source-side aggregates. Numeric pseudonyms become strings. Unsupported SQL stays
unknown; this deliberately avoids claiming complete lineage analysis. JSON paths
are bounded and exact; dynamic keys still need an explicit schema to distinguish
all business identifiers. Local mappings/artifacts may be large and retain their
existing budgets. This is data minimization, not anonymity or protection from a
malicious SQL author encoding sensitive values as counts/booleans/metadata.
