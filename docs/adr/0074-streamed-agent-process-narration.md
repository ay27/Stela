---
type: ADR
id: "0074"
title: "Streamed Agent process narration"
status: active
date: 2026-08-20
---

## Context

AgentHarness already streams ordinary assistant text for every model step, but
Stela records those messages only in local Metrics and sends the Agent Panel a
single `final` event after the entire tool loop settles. Long analyses therefore
look idle or tool-only until the answer is complete, even when the model has
already explained its current direction. Forwarding raw provider output would
also expose reasoning blocks, tool-call arguments, excessive IPC traffic, and
partial text that should not become durable conversation history.

## Decision

**Stream bounded ordinary assistant text to the Agent Panel as typed
`assistant_progress` snapshots. Streaming snapshots are ephemeral and throttled;
one completed snapshot per model step is persisted in device Agent history. The
Renderer upserts snapshots by run and step, promotes the matching final step into
the final answer, and collapses earlier process narration after the run ends.**

Thinking/reasoning blocks and tool-call deltas never enter process narration.
Stela does not prompt the model to manufacture narration for tool-only steps.
Strategy-review actions remain causal timeline entries but render collapsed by
default.

## Options considered

- **Typed bounded process snapshots** (chosen): provides immediate direction,
  preserves replayable completed steps, and avoids token-level IPC and hidden
  reasoning disclosure.
- **Show only deterministic tool status**: safe and compact, but cannot tell the
  user what interpretation or direction the model selected.
- **Render every raw model/provider event**: maximally transparent, but noisy,
  provider-specific, unsafe for reasoning content, and expensive to persist.
- **Require a narration sentence before every tool call**: gives uniform output,
  but changes Agent behavior, latency, and token use even when a model naturally
  emits only a tool call.

## Consequences

- Long runs provide useful visible progress before their final answer.
- Completed model-step narration increases device history size, so each snapshot
  is bounded and intermediate streaming snapshots are never persisted.
- Final promotion and history replay must remain compatible with older `final`
  events that have no model-step index.
- The Panel keeps its concise post-run shape by collapsing process narration and
  strategy-review details unless the user expands them.
- Re-evaluate if providers routinely emit no ordinary text before tool calls or
  if persisted narration volume requires a stricter per-session retention cap.
