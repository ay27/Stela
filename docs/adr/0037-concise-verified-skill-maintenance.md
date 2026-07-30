---
type: ADR
id: "0037"
title: "Concise verified Skill maintenance"
status: superseded
superseded_by: "0043"
date: 2026-07-27
---

## Context

Supersedes [ADR-0033](0033-explicit-and-automatic-skill-maintenance.md).

Skills are intended to preserve reusable data knowledge, but a broad file-size
limit and maintenance access to a full final answer make it easy to save an
analysis transcript, SQL output, or a one-off conclusion instead. That reduces
retrieval quality and grows prompt cost.

## Decision

**Keep Skills as concise, verified reusable rules.** Both explicit and automatic
writes use the same content budget and reject oversized descriptions, bodies, and
code examples. Automatic maintenance saves only when it can identify reusable
scope, evidence from the completed work, and no equivalent existing Skill; it
receives a bounded evidence summary and only the relevant Skill resources.

## Options considered

- **Concise validated writes with conservative automation** (chosen): preserves
  automatic learning without treating every successful analysis as knowledge.
- **Prompt-only guidance**: inexpensive but cannot reliably prevent large or
  archive-like files.
- **Human review queue**: stronger oversight, but adds lifecycle state, UI, and
  operational work before the current library has demonstrated that need.

## Consequences

- Skill authors must keep only scope, rule, and minimal verification or exception;
  full SQL, result rows, and analysis narration remain in existing run history and
  Vault notes.
- Some legitimate but verbose write attempts are rejected and need compression.
- The library continues to use Vault Markdown and Git; no new store or approval
  workflow is introduced.
- Re-evaluate if compact Skills still cause material duplicate or stale knowledge;
  a review queue or lifecycle metadata can then be considered separately.
