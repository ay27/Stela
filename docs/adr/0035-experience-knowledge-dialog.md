---
type: ADR
id: "0035"
title: "Experience Knowledge dialog"
status: superseded
superseded_by: "0036"
date: 2026-07-26
---

## Context

Supersedes [ADR-0034](0034-read-only-experience-knowledge-library.md).

The compact bottom-bar popover obscures complete Skill descriptions and paths,
which prevents useful review as the experience library grows.

## Decision

**Open Experience Knowledge in an application-level read-only dialog from the
bottom-bar entry point.** The dialog presents complete active and archived Skill
metadata in scrollable cards, while the same `agent.listSkills()` bridge remains
the only renderer-facing Skill API.

## Options considered

- **Large read-only dialog** (chosen): fits complete metadata and follows the
  application-wide dialog lifecycle.
- **Bottom-bar popover**: keeps the interaction compact but constrains content
  and discovery.
- **Editable Skill manager**: broadens mutation access and duplicates the
  validated Agent write boundary.

## Consequences

- The dialog is mounted at `AppShell`, so it remains stable across layout changes.
- Renderer access remains metadata-only; `save_skill` is still the sole write path.
- The library is still loaded on demand and adds no startup or Agent context cost.
