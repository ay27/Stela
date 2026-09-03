---
type: ADR
id: "0085"
title: "Extension-routed workspace editors"
status: active
date: 2026-09-02
---

## Context

Workspace file tabs previously sent every non-Canvas file through Milkdown. When
source files such as SQL or Python were parsed as CommonMark, soft line breaks
were rendered as paragraph whitespace and the visible file no longer matched its
on-disk text. Sending unknown files through a text editor would also risk opening
binary content and later overwriting it as UTF-8.

## Decision

**Route workspace files by their extension: Stela `.md` notes use Milkdown,
`.stela.canvas` artifacts use the Canvas workspace, recognized source and plain
text files use CodeMirror, and unknown or binary-like files remain unsupported.**

Source files reuse the existing vault read/write boundary and tab lifecycle, but
they are not treated as Stela notes or supplied as implicit Agent note context.

## Options considered

- **Extension-routed editors** (chosen): preserves source text semantics and keeps
  each artifact in the editor designed for it; requires an explicit support list.
- **Make Milkdown preserve soft breaks:** reduces the visible symptom but still
  parses source text as Markdown and can transform other syntax during save.
- **Treat every non-Markdown file as UTF-8 source:** maximizes coverage but may
  expose binary or unknown files to destructive text serialization.

## Consequences

Common source files gain line-accurate editing, language-aware highlighting, and
the existing autosave/external-change behavior without new IPC. New file formats
must be recognized by CodeMirror language metadata or the explicit plain-text
allowlist. Binary-like content is displayed as unsupported, and SQL source files
do not gain RunSQL execution semantics from this decision.
