---
type: ADR
id: "0063"
title: "ProseMirror-backed Agent composer"
status: active
date: 2026-08-12
---

## Context

ADR-0062 keeps user-authored resources as ordered inline pills. The first
composer implementation represented those pills as mention markup inside a
controlled `contenteditable`, then translated a visible-character offset back
into a browser DOM selection after every external update. Programmatic Add to
Chat, panel unmounting, atomic pill boundaries, and IME composition made that
offset reconstruction unreliable.

Stela already ships ProseMirror through Milkdown and uses its transactions,
selections, plugins, and atomic NodeViews in the note editor.

## Decision

**Use a small, plain-text ProseMirror schema as the Agent draft authority, with
atomic resource nodes and one EditorState per Agent tab. Serialize only at the
existing AgentMessageContent boundary.**

Pasting a resource pill produces its visible text instead of transferring the
resource body. External Add to Chat inserts through a ProseMirror transaction
at the saved selection head.

## Options considered

- **Direct ProseMirror composer** (chosen): reuses Stela's editor stack and
  gives selections, history, IME, and atom boundaries one state authority.
- **Continue patching the mention contenteditable**: smaller initial diff, but
  retains DOM-range reconstruction and competing controlled state.
- **Add Lexical or Tiptap**: provides mature editor behavior, but introduces a
  second editor stack or a wrapper over ProseMirror that Stela does not need.

## Consequences

- AgentMessageContent, persisted history, IPC, and model input remain stable.
- Panel collapse and Agent-tab switches preserve selection and undo history in
  disposable renderer state without keeping the panel DOM mounted.
- The composer owns a small schema, resource catalog plugin, autocomplete
  state, and serialization adapter that require focused regression tests.
- Arbitrary rich-text formatting remains out of scope; re-evaluate if Agent
  drafts need formatting beyond text, hard breaks, and resource atoms.
