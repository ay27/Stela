---
type: ADR
id: "0102"
title: "Unified CodeMirror conversation composer"
status: active
date: 2026-09-10
---

## Context

Supersedes [ADR-0063](0063-prosemirror-agent-composer.md). Agent Panel and workspace chat need the same SQL editing, inline references and keyboard behavior.

## Decision

Use one CodeMirror 6 composer and per-conversation EditorState. Resource atoms live in a transaction-mapped state field with replacement widgets and undoable effects. AgentMessageContent remains the serialization boundary. Reuse deterministic RunSQL completion and formatting; no AI completion is installed. Enter inserts a newline and Mod-Enter sends. SQL recognition is conservative and never changes routing authority.

## Options considered

- CodeMirror with resource atoms (chosen): reuses SQL machinery and one editing authority.
- ProseMirror with nested SQL editors: adds focus, selection and history boundaries inside free-form mixed input.

## Consequences

Selection and undo survive view remounts. Resource mapping, IME, copy/paste and SQL region detection require regression coverage. Both surfaces share a shell and resource provider; main-process execution remains separate.
