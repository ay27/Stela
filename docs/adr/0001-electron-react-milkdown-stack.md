---
type: ADR
id: "0001"
title: "Electron + React + Milkdown as application stack"
status: active
date: 2026-03-15
---

## Context

Stela began as an Obsidian plugin (Node/CJS + Obsidian APIs), then explored a Tauri v2 + Rust backend for desktop distribution. The team needed a cross-platform desktop shell with filesystem access, native SQLite, connector subprocess management, Git integration, and a rich Markdown/SQL editor — built primarily by a small team with AI assistance.

## Decision

Use **Electron 41** (Node main process + Chromium renderer) with **React 18 + TypeScript**, **Milkdown 7** for WYSIWYG Markdown editing, **CodeMirror 6** for SQL blocks, and **better-sqlite3** in the main process for result storage.

## Options considered

- **Tauri v2 + Rust** (previous prototype): lighter runtime, safer filesystem boundary. Rejected for open-source release — Rust connector ecosystem friction, longer iteration cycle for SQL plugin work, and team velocity favored staying in TypeScript end-to-end.
- **Electron** (chosen): mature desktop packaging, direct Node access for connectors and SQLite, shared TypeScript across main/renderer/preload. Trade-off: larger bundle (~150MB), but acceptable for a data-workspace tool.
- **Pure web app**: no local filesystem, no safeStorage, no subprocess connectors. Rejected — local-first is a core principle.
- **Obsidian plugin only** (original): dependent on Obsidian runtime, limited IPC, no standalone distribution. Retired — archived to `legacy-obsidian-plugin/`.

## Consequences

- Single language (TypeScript) across renderer, preload, main, and connector plugins
- Native modules (better-sqlite3) require `electron-rebuild` on Electron upgrades
- Security depends on strict preload isolation — see ADR-0004
- electron-builder provides macOS/Windows/Linux artifacts with GitHub Releases auto-update
- Triggers re-evaluation if: Electron security posture degrades, or a lighter shell (Tauri) matures enough to absorb connector/SQLite complexity without velocity loss
