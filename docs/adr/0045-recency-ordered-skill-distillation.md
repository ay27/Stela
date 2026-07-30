---
type: ADR
id: "0045"
title: "Recency-ordered Skill distillation"
status: active
date: 2026-07-30
---

## Context

Supersedes [ADR-0044](0044-associative-skill-distillation.md).

Related SQL usage can lead to notes that document superseded procedures. Treating
all historical records equally preserves stale rules in newly distilled Skills.

## Decision

**Associative SQL-usage results are ordered by the Markdown document's update
time, newest first.** Maintenance reads only the first three returned notes; if
their instructions conflict, the newest updated note is authoritative.

## Options considered

- **Document-update recency** (chosen): follows the Vault's current reviewed
  documentation without adding another history store.
- **Latest SQL execution date**: describes the last run, which may repeat an
  obsolete procedure.
- **Require cross-record consensus**: rejects valid current corrections whenever
  an older note disagrees.

## Consequences

- A recent edit can intentionally supersede older operational guidance.
- File modification time is the authority; users restoring files should preserve
  timestamps when chronology matters.
- If the newest note is ambiguous, maintenance skips the Skill rather than
  inventing a merged rule.
