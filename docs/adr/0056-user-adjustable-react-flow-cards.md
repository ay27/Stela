---
type: ADR
id: "0056"
title: "User-adjustable React Flow cards"
status: active
date: 2026-08-07
---

## Context

Supersedes [ADR-0055](0055-vault-analysis-canvas-artifacts.md).

The separate, Git-trackable Analysis Canvas remains the right home for durable
multi-view analysis, but a fully read-only workspace cannot preserve a user's
preferred arrangement of a process or lineage diagram. Mermaid inside a
Markdown card also gives Stela little control over appearance, node semantics,
layout persistence, or later Agent updates.

## Decision

**Keep `*.stela.canvas` as the structured analysis artifact, add a controlled
`flow` card rendered by React Flow, and let users edit only Flow direction and
node positions through an etag-protected layout IPC while the Agent owns graph
content.**

Flow nodes use the bounded `step | decision | source | result | note` kinds and
edges may carry labels and semantic tones. Dagre supplies deterministic TB/LR
auto-layout. Agent updates preserve existing layout by stable card and node ids,
strip model-authored positions for new nodes, and cannot persist viewport state.
Canvas Markdown renders Mermaid as ordinary code; Mermaid remains available in
normal Markdown notes.

## Options considered

- **React Flow with a narrow layout mutation** (chosen): controlled visual
  semantics and useful direct manipulation, at the cost of two renderer
  dependencies and a dedicated IPC method.
- **Mermaid in Canvas Markdown**: compact text protocol, but limited styling,
  weaker interaction, and an uncontrolled diagram language.
- **Fully editable graph builder**: maximum flexibility, but requires graph
  authorship, conflict, connection, and deletion semantics that the current
  Agent-generated Canvas does not need.
- **No persisted layout**: smaller contract, but every revisit loses deliberate
  user arrangement.

## Consequences

- Canvas cards are `markdown | kpi | chart | table | flow`; Flow is source-free.
- `@xyflow/react` renders the interactive view and `@dagrejs/dagre` computes
  auto-layout. Static HTML export emits inert SVG/HTML from the same positions.
- A typed `canvas:update-flow-layout` capability validates Vault paths, card and
  node ids, bounded finite coordinates, and the current etag before atomic write.
- Users can drag nodes and choose TB/LR or auto-layout, but cannot add, remove,
  connect, relabel, or restyle graph content.
- There is no migration for the unreleased Mermaid-in-Canvas representation.

