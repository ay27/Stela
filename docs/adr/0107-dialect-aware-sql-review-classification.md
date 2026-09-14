---
type: ADR
id: "0107"
title: "Dialect-aware SQL review classification"
status: active
date: 2026-09-14
---

## Context

The lexical guard treats optimizer hints as executable comments and reports ambiguous SQL as mutation. StarRocks SELECT statements containing SET_VAR hints therefore receive misleading write warnings.

## Decision

Pass the selected connection dialect to the shared SQL guard. Permit closed optimizer hint comments for StarRocks only; preserve executable-comment, malformed syntax and multi-statement safeguards. Classify uncertainty as `unknown`, requiring review under the existing approval policy, with an uncertainty-specific explanation. Python read-only queries reject uncertainty. Never rewrite the executed SQL.

## Options considered

- Dialect-scoped lexical support (chosen): small change with conservative fallback.
- Globally ignore all comments: loses executable-comment protection.
- Full SQL parser: major dependency and broader dialect compatibility work.

## Consequences

This remains a conservative lexical classifier, not proof that every SELECT is side-effect free. Unknown dialects keep existing restrictive hint behavior. Stored Canvas definitions without a resolved dialect remain conservative.
