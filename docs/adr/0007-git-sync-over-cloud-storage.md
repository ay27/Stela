---
type: ADR
id: "0007"
title: "Git sync instead of cloud object storage"
status: active
date: 2026-04-15
---

## Context

Stela v0.2 used COS (cloud object storage) to sync vault content and execution artifacts across devices. This introduced vendor dependency, opaque conflict resolution, credential management complexity, and poor offline behavior. Users already version their analytical work in Git.

## Decision

**Use Git as the vault sync transport.** Markdown notes and JSONL execution history are tracked. SQLite caches and machine-local files are gitignored. `sync-orchestrator` coordinates pull → JSONL import → index refresh. AutoGit provides idle/inactive checkpoint commits. Remote authentication delegates to system `git` — no provider-specific OAuth.

## Options considered

- **COS object storage** (v0.2): push/pull blobs to cloud. Rejected — vendor lock-in, no meaningful diff, requires separate credential flow.
- **Custom sync server**: full control, but operation burden. Rejected for v1.
- **Git** (chosen): users already have remotes; diffs are meaningful; offline commits work; JSONL per-device shards avoid conflicts.
- **No sync** (local only): simplest, but blocks multi-device workflows. Rejected as default — Git is opt-in via settings.

## Consequences

- `electron/services/git/` provides init, status, commit, push, pull, conflict detection
- `.gitignore` managed by `ensureGitignore()` on vault open
- AutoGit respects `git.enabled`, `autoCommit`, `autoPush`, `autoPull` settings
- Large JSONL history increases repo size — `persistence.cleanupMonths` controls retention
- Non-git vaults still work; Git features gated in UI
- Triggers re-evaluation if: vault size or JSONL volume makes Git impractical without Git LFS or selective sync
