---
type: ADR
id: "0048"
title: "Vault Markdown SQL template library"
status: active
date: 2026-07-31
---

## Context

Users need reusable parameterized SQL that remains editable as a normal Stela
document, works offline, and follows the Vault through Git. Templates must not
appear as ordinary notes or pollute the SQL usage index.

## Decision

**Store each SQL template as Markdown at
`{vault}/.stela/sql-templates/<slug>.md`.** A template uses
`type: stela-sql-template`, `name`, `description`, and `connection_name`
frontmatter plus its first `runsql` block. The renderer uses the existing
typed Vault file bridge to create, list, read, and trash templates.

`{{variable}}` placeholders open a CodeMirror multi-selection variable session
at insertion time; linked occurrences and Tab navigation are local editor state.

## Options considered

- **Hidden Markdown library** (chosen): preserves normal document editing and
  Git review without listing templates as user notes or indexing them as SQL
  usage.
- **Visible `templates/` note directory**: simple, but pollutes normal note
  navigation and search results.
- **Single JSON registry**: compact metadata, but needs a separate editor and
  loses Markdown-first review.

## Consequences

- Templates are Git-synced Vault content, not machine-local preferences.
- The `.stela` watcher intentionally ignores this directory, so dialogs and
  pickers load templates on demand.
- The first RunSQL block is the insertion payload; additional blocks and prose
  are allowed for authoring context but are not inserted.
- Re-evaluate if templates need shared structured fields beyond frontmatter or
  concurrent high-volume mutations.
