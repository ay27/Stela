---
type: ADR
id: "0080"
title: "Guarded native FIM for SQL inline completion"
status: superseded
superseded_by: "0087"
date: 2026-08-27
---

## Context

Supersedes [ADR-0028](0028-inline-completion-schema-and-note-context.md).

ADR-0028 kept SQL inline completion on pi-ai's chat transport, limited it to a
single line at a line tail, and sent a broad prompt containing prefix, suffix,
nearby blocks, note prose, and schema DDL. That shape has three product
problems: a hard editor guard makes fill-in-the-middle impossible, chat models
must infer an insertion protocol from prose, and requests can spend far more
tokens on context than the short suggestion warrants.

DeepSeek's official V4 Flash profile now exposes a native non-thinking FIM API.
Stela still supports many pi-ai and custom provider profiles, so native FIM
cannot become a guessed property of every OpenAI-compatible endpoint. Inline
completion must also remain optional, cancellable, credential-isolated in main,
and cheap enough to run after ordinary editing.

## Decision

**Use guarded native FIM for the official DeepSeek V4 Flash profile, retain a
bounded chat fallback for other configured profiles, and allow edit-triggered
completion at any SQL cursor position.**

- `vendorId=deepseek` with model `deepseek-v4-flash` calls the official
  `/beta/completions` endpoint directly from main. It is non-thinking,
  deterministic, short, and receives real prefix/suffix fields.
- Other builtin and custom profiles keep the existing pi-ai chat transport.
  Stela never infers native FIM support from a custom model name.
- A failed native FIM request does not issue a chat request in the same attempt;
  avoiding duplicate billing and an unexpected quality downgrade is more
  important than always producing ghost text.
- The typed start/cancel/event IPC remains unchanged. Native non-streaming text
  is delivered as one `delta` followed by `final`.
- Automatic requests happen only after document edits and a quiet period, but
  may originate anywhere in SQL. Cursor movement alone stays free. A manual
  shortcut can request the current cursor context without an edit.
- Local syntax/context gates run before the request. Deterministic overlap,
  length, and schema guards run before display. There is no separate model call
  to decide whether completion is suitable.
- Context is compact and cursor-local. Live renderer columns remain
  authoritative; schema documents contribute comments and compact fallback
  columns, never full storage-engine DDL.
- Completion stays out of production Agent metrics. Quality, latency, cache
  tokens, and estimated cost are measured by the explicit completion evaluator.

## Options considered

- **Official DeepSeek native FIM plus bounded chat fallback** (chosen): gives
  the selected model its intended insertion protocol without changing existing
  provider settings; it adds one small provider-specific HTTP transport.
- **Chat simulation for every provider**: portable, but preserves the protocol
  mismatch and poor middle-of-line accuracy.
- **Expose configurable FIM URL/model settings**: portable in theory, but adds
  user-facing configuration and a trust/capability contract for arbitrary
  gateways before there is a second proven implementation.
- **Call a classifier before completion**: lets a model decide whether to call
  another model, but nearly doubles request count and latency.

## Consequences

- Official DeepSeek completion no longer flows through pi-ai, though API keys,
  cancellation, validation, and error normalization remain Stela-owned in main.
- Native FIM is a beta upstream contract and can fail independently of chat.
  Such failures produce no suggestion and no automatic paid retry.
- Moving the cursor does not spend tokens. Editing in the middle can now spend
  tokens, so debounce, duplicate suppression, compact context, and a bounded
  memory cache are required.
- Multiline ghost text requires layout-aware renderer styling, but insertion is
  still one undoable CodeMirror transaction.
- Re-evaluate if pi-ai gains a portable native FIM capability, DeepSeek removes
  or materially changes the beta endpoint, measured latency misses the inline
  UX budget, or another provider justifies a first-class capability contract.
