---
type: ADR
id: "0120"
title: "Compact random conversation pseudonyms"
status: active
date: 2026-09-25
---

## Context

ADR-0118 retains long namespace-prefixed pseudonyms from ADR-0117. Repeating
these tokens in every query cell consumes substantial model context.

## Decision

**New identities use PII_ followed by random uppercase hexadecimal digits,
starting with three digits and expanding only after that width is exhausted.**
Sample without replacement within the conversation; keep the namespace in local
mapping state, not in model-visible tokens. Tasks share that conversation's
identity store but never grants. Mapping format 2 accepts both short tokens and
legacy long tokens; format 1 loads and upgrades when a new identity is added.
Existing entries are never silently renumbered. History forks remap through the
destination store. SQL, display, copy and streaming use a shared whole-token
grammar, so a three-digit token cannot match the prefix of a longer token.

## Options considered

- **Random compact codes (chosen):** seven characters initially, stable locally.
- Sequential numbers: shorter but reveal allocation order.
- Embedded random namespace: avoids cross-conversation collisions but expensive.

## Consequences

Codes are unique only within their conversation; independent conversations can
coincidentally use the same code. Mapping authority must stay conversation scoped.
Old conversations keep existing long entries. Partial streaming codes are hidden
until a delimiter or final message establishes their boundary. Pseudonyms remain
data minimization, not encryption; existing map storage and budgets still apply.
