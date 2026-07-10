---
type: ADR
id: "0016"
title: "Agent chat references and Add to Chat"
status: active
date: 2026-07-10
---

## Context

The harness agent already has tools to search and read notes, inspect schemas, and run SQL. Users also need a direct way to tell the agent which current note, related notes, selected prose, or RunSQL block should shape the next turn. Injecting full notes into every request would fight Stela's search-first AI model and make token use unpredictable, while plain text-only prompts lose the structure needed for future UI and auditing.

## Decision

**Agent chat uses structured references: note paths are sent as references for tool-driven `read_note`, while selected prose and RunSQL snippets are sent as bounded content attachments on the current user turn.** The renderer exposes `@` for table mentions, `[[` for note-path references, a default current-note chip, and `Add to Chat` via context menu / `Cmd+I`.

## Options considered

- **Structured references and bounded attachments** (chosen): preserves the tool-driven agent architecture, keeps note content out of the prompt until the model asks for it, and still sends exact user-selected text or SQL when the user explicitly adds it.
- **Preload all referenced note bodies**: simplest for the model on the first turn, but risks large prompts and duplicates the `read_note` tool.
- **Serialize everything into prompt text only**: smallest IPC change, but loses durable structure for chips, timeline, truncation, and future UI.

## Consequences

- `AgentRunRequest` now carries `referencedNotes` plus content `attachments`; IPC schema validation remains the trust boundary.
- The agent system prompt points at referenced note paths and tells the model to use `read_note` rather than guessing contents.
- The current user message includes selected prose / RunSQL snippets with a fixed character budget.
- `Cmd+I` is reserved for Add to Chat. RunSQL rewrite / ask remain available from UI buttons and context menus, without keyboard shortcuts.
- Re-evaluate if users need persistent attachment history, editable attachment contents, or automatic full-note context for small files.
