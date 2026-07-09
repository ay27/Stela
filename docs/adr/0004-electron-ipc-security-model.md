---
type: ADR
id: "0004"
title: "Electron IPC security model with typed preload bridge"
status: active
date: 2026-03-22
---

## Context

Electron grants the main process full Node.js access. The renderer loads untrusted content (user Markdown, external images, Mermaid diagrams). A compromised renderer must not gain filesystem, subprocess, or credential access.

## Decision

**Enforce a three-layer security model:**

1. Renderer: `nodeIntegration: false`, `contextIsolation: true`, `webSecurity: true`
2. Preload: expose only `window.stela.<domain>.<method>()` — one typed method per capability, **no** generic `invoke(channel, args)`
3. Main: every `ipcMain.handle` input validated with Zod (`electron/shared/ipc-schema.ts`); vault writes pass `ensureWithinVault`; deletes use `shell.trashItem`; external links use `shell.openExternal` with `http(s):` / `mailto:` allowlist

## Options considered

- **Expose ipcRenderer to renderer**: fastest to build, impossible to audit. Rejected.
- **Generic invoke wrapper in preload**: flexible but allows renderer to call any channel. Rejected.
- **Typed per-capability preload API + Zod** (chosen): verbose to maintain, but auditable and testable.

## Consequences

- Adding a capability requires 6-step checklist: channel → schema → service → handler → preload → `stela-bridge.d.ts`
- `assertAllRegistered()` at startup catches orphan channels
- Errors normalized to `{ code, message, retryable }` — renderer never sees stack traces
- CSP differs dev (`unsafe-eval` for Vite HMR) vs prod (`self` only)
- Credentials wrapped via `safeStorage` in main before writing `secrets_{slug}.json`
- Triggers re-evaluation if: Electron introduces a safer default IPC pattern that reduces boilerplate without weakening the boundary
