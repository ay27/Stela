---
type: ADR
id: "0027"
title: "Agent clarification questions as a third proposal kind"
status: active
date: 2026-07-25
---

## Context

Extends [ADR-0013](0013-agent-tools-sql-guard-and-proposals.md), which
established the blocking proposal handshake for SQL mutations and note writes:
a tool call parks its promise, the run emits an `ai:agent-event` proposal, and
the renderer's approve/reject resolves it to a `boolean`.

The agent had no way to say "I don't know which of these two columns you mean."
Faced with an ambiguous Chinese business term mapping to several plausible
columns, or with contradictory metric definitions across notes, it silently
picked one and presented the result as fact. Users could not tell which numbers
rested on a guess.

Constraints: no new IPC channel if an existing one fits; questions must not
become a way for a model to stall a run indefinitely or to nag; nothing about
the security boundary of the existing proposal flow may loosen (an answer is
plain text from the user, never an instruction that bypasses mutation approval).

## Decision

**Add `question` as a third proposal kind and an `ask_user` tool, reusing the existing blocking proposal handshake with its resolution widened from `boolean` to `boolean | string`.**

- `AgentProposalKind` becomes `edit_note | mutation_sql | question`.
  `AgentProposalPayload` gains optional `question` and `options`;
  `AgentProposalResponse` gains an optional `answer`. No new channel: the
  existing `ai:agent-event` proposal event and
  `AI_AGENT_RESPOND_PROPOSAL` invoke carry it.
- The renderer renders a `QuestionCard` — up to six suggested options as buttons
  plus a free-text field, and a skip action. Skipping resolves as "not
  answered", not as approval of anything.
- `ask_user({ question, options?, context? })` returns the answer to the model as
  tool output. At most three questions per run, enforced in the tool, not the
  prompt. Exceeding it returns an error telling the model to pick the most
  defensible reading and state it as an assumption.
- The system prompt requires exhausting self-checkable sources first (schema,
  DDL comments, notes, a small `GROUP BY` sample) and reserves questions for
  what data cannot answer.
- Final answers must carry a fixed contract: conclusion, evidence (table ·
  column · SQL), key numbers, **assumptions made**, and remaining uncertainty.
- Durable answers are written back through the existing `propose_edit` tool into
  a note section, so [ADR-0026](0026-ranked-lexical-retrieval-for-agent.md)'s
  heading-aware ranking makes them findable next time. No frontmatter contract,
  stable ids, or answer lifecycle is introduced.

## Options considered

- **Third proposal kind** (chosen): reuses the blocking handshake, the event
  stream, the cancellation path, and the timeline UI. Widening the resolution
  type is the entire protocol change.
- **Dedicated question IPC channel and store**: cleaner separation, but a second
  parallel blocking mechanism to keep correct under cancel, compaction, and
  window close. Rejected.
- **Prompt-only instruction to ask in prose**: zero code, but the model's
  question arrives as chat text with no blocking, so the run finishes before the
  user reads it. Rejected.
- **Unlimited questions**: rejected; a model that is uncertain everywhere would
  turn a run into an interview.

## Consequences

- Ambiguity now surfaces as a visible question with an audit trail in the
  timeline instead of a silent guess.
- Proposal resolution is no longer a boolean, so every consumer of
  `requestProposal` must handle a string; the mutation and note-write paths
  treat any non-`true` value as "not approved".
- A run can block on a human for as long as the window stays open. Cancellation
  and window close resolve it the same way rejection does.
- Three questions per run is arbitrary. Re-evaluate if users report the agent
  asking too often, if it burns questions on things it could have checked, or if
  a queue of non-blocking clarifications turns out to fit the workflow better.
