---
type: ADR
id: "0002"
title: "Markdown + JSONL as dual authority stores"
status: active
date: 2026-03-20
---

## Context

Stela notes must remain readable outside the app (GitHub, VS Code, Obsidian). SQL execution produces large result sets that cannot practically live in Markdown files. The app also needs cross-device sync without write conflicts when two machines execute queries concurrently.

## Decision

**Markdown files are the semantic authority.** **Append-only JSONL files** (`{vault}/.stela/history/history_{deviceSlug}.jsonl`) are the **execution history authority**. Each device writes only to its own JSONL shard; Git merges shards without line-level conflicts. Both are Git-synced.

## Options considered

- **Markdown only** (results in `<detail>`): simple, but caps result size and bloats Git diffs. Rejected for full result retention.
- **SQLite only**: fast queries, but opaque to Git, not human-readable, creates sync conflicts. Rejected as sole authority — demoted to cache (ADR-0003).
- **Cloud object storage (COS)** (v0.2 approach): centralized blob sync. Rejected — vendor lock-in, complex conflict model, poor offline support. Superseded by Git (ADR-0007).
- **Markdown + per-device JSONL** (chosen): prose and SQL stay in `.md`; complete run packages append to device-specific JSONL. Git tracks both.

## Consequences

- Notes stay plain Markdown with human-readable `<detail>` summaries
- Full result sets survive in JSONL even if local SQLite is deleted
- Cross-device: pull JSONL → incremental import rebuilds SQLite cache
- Each machine needs a stable device slug (`device-profile.json`) for JSONL filename
- Git repo size grows with execution history — cleanup policy in settings controls retention
- Triggers re-evaluation if: JSONL files grow beyond practical Git performance (millions of runs per device)
