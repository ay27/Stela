---
type: ADR
id: "0061"
title: "Ordered inline Agent message resources"
status: superseded
superseded_by: "0062"
date: 2026-08-12
---

## Context

Supersedes [ADR-0016](0016-agent-chat-references-and-add-to-chat.md).

Agent messages stored plain prompt text, table and note arrays, one active
Canvas, and bounded attachments separately. The composer rendered some of
those references inline and others above the editor, while history reconstructed
them in a third order. Multiple references therefore lost the exact point at
which the user introduced them.

## Decision

**Represent every new Agent user turn as an ordered message containing text
segments and inline resource references backed by one deduplicated resource
catalog. The composer, history, timeline, and model input use that same order.**

Tables, notes, Canvases, RunSQL blocks, and selections share the resource
contract. The main process validates, redacts, and bounds resources but leaves
tool choice to the model. Dynamic message content remains at the end of the
conversation so the stable prompt prefix from ADR-0060 is preserved.

## Options considered

- **Ordered segments plus resource catalog** (chosen): preserves positional
  meaning without duplicating large SQL or selection snapshots.
- **Inline display with separate request arrays**: smaller migration, but the
  persisted and model-visible message would still lose ordering.
- **Serialize pills into plain prompt text**: preserves rough order but loses
  typed navigation, validation, redaction, and exact history rendering.

## Consequences

- New requests carry a versioned message document; legacy history is normalized
  at read time and cannot recover positions that were never stored.
- The renderer owns caret-aware insertion and resource navigation. No generic
  IPC or renderer Node privilege is introduced.
- Resource locators add state and fallback behavior for renamed or edited
  sources, and must never silently navigate to a different resource.
- Re-evaluate if the composer needs arbitrary rich-text formatting beyond text
  and atomic resource pills.
