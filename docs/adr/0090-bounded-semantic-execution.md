---
type: ADR
id: "0090"
title: "Bounded host-mediated semantic execution"
status: active
date: 2026-09-05
---

## Context

Python handles complete data but cannot reliably replace semantic classification,
extraction or entity resolution with generated regular expressions.

## Decision

**Expose asynchronous classify, extract and conservative resolve operations in
the Python workspace, with all inference authorized, budgeted and validated by
the host using existing provider transports.**

Only selected columns leave the sandbox. The host binds requests to an active
job, Vault, session and resolved model. No credentials or arbitrary network API
enter Python. Authorization is local to Vault and provider endpoint/model, with
explicit budget increases. Retries consume the same run budget. Unknown, failed
and unprocessed records remain visible; schema validation does not prove meaning.
Entity candidates are deterministic and bounded; incomplete coverage and
non-transitive matches cannot establish an automatic merge.

## Options considered

- **Small shared broker and Python helpers** (chosen): desktop/headless parity and bounded authority.
- Full semantic framework: extra dependencies and a second runtime configuration surface.
- General LLM/network callable: flexible but unbounded data disclosure and spending.

## Consequences

Adds a typed IPC capability, model selection, local grants and usage accounting.
Batch results and caches are disposable workspace state. No embeddings, autonomous
sub-agent, final-answer reviewer gate, or new artifact handoff is introduced.
Accuracy and total inference cost require matched, repeated evaluation.
