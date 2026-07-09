# AGENTS.md — Stela

Stela is a local-first Electron desktop app for SQL data notes (Markdown + `runsql` + Git-friendly execution history).

## 1. Before writing code

1. Read the task fully.
2. Load architecture context as needed:
   - `docs/ARCHITECTURE.md` — process model, storage authorities, IPC, connectors, Git, AI
   - `docs/ABSTRACTIONS.md` — domain types and contracts
   - `docs/adr/` — active decisions that constrain the change
3. If the task involves a structural choice (see ADR triggers below), decide the ADR **before** implementing.
4. Prefer reuse: existing components, services, contracts, and patterns over new abstractions.

## 2. Architecture boundaries (non-negotiable)

Electron three-process model — **never cross boundaries directly**:

| Layer | Path | Rule |
|-------|------|------|
| Renderer | `src/` | No Node privileges; only `window.stela.*` |
| Preload | `electron/preload/` | Typed per-capability API; no generic `invoke(channel, args)` |
| Main | `electron/main/` | Window, IPC router, vault context, security |
| Services | `electron/services/` | Main-process business logic |
| Shared | `electron/shared/` | Channels, Zod schemas, DTOs, errors |

New desktop capability checklist:

1. `electron/shared/ipc-channels.ts` — channel constant
2. `electron/shared/ipc-schema.ts` — Zod input schema
3. `electron/services/` — implementation
4. `electron/main/handlers.ts` — register handler
5. `electron/preload/index.ts` — expose typed method
6. `src/types/stela-bridge.d.ts` — renderer types
7. Renderer calls `window.stela.<domain>.<method>()`

Security baseline: `contextIsolation`, Zod on every IPC input, `ensureWithinVault` for vault writes, `shell.trashItem` for deletes, `safeStorage` for secrets.

## 3. ADRs & docs (mandatory for structural work)

### When to create an ADR

Create an ADR when the work involves any of:

- New or removed major dependency
- Storage / sync strategy change
- IPC, security, or process-boundary change
- Connector plugin protocol or trust model change
- New core abstraction or domain model
- Cross-cutting pattern that future code must follow

**Do not** create ADRs for: bug fixes, styling, behavior-preserving refactors, or test-only changes.

### ADR rules

- Location: `docs/adr/`
- One decision per file: `NNNN-short-kebab-title.md`
- Once `active`, never edit body content — supersede instead
- Update `docs/adr/README.md` index in the same change
- Prefer creating the ADR in the **same commit** as the code
- Use the project skill: `.cursor/skills/create-adr/SKILL.md`

### When to update docs

| Change | Update |
|--------|--------|
| Process model, storage authorities, IPC shape, connector/Git/AI architecture | `docs/ARCHITECTURE.md` |
| Domain types, contracts, frontmatter/`<detail>` shape, settings boundary | `docs/ABSTRACTIONS.md` |
| New/superseded architectural decision | `docs/adr/` + README index |

### Task completion checklist

Before declaring a task done, state explicitly:

- **ADRs:** new/superseded ADR ids, or `none`
- **Docs:** which docs updated, or `none`
- Brief note of what was implemented

## 4. Coding conventions

- TypeScript strict; no `@ts-ignore`; avoid `any`
- Interfaces for contracts (`I` prefix for exported interfaces); `type` for unions/utilities
- UI: React + Tailwind + shadcn/ui; state in Zustand (`src/state/`)
- Editor: Milkdown 7 + CodeMirror 6 RunSQL NodeViews
- CSS classes use `stela-` prefix; colors via CSS variables
- Commit messages: English `type(scope): description`
  - types: `feat` / `fix` / `refactor` / `test` / `docs` / `chore`
  - scopes: `main` / `preload` / `renderer` / `ipc` / `vault` / `storage` / `connector` / `search` / `secrets` / `editor` / `ui` / `build` / `docs`

## 5. Build & test

```bash
npm run dev          # electron-vite hot reload
npm run build        # tsc --noEmit + plugins + electron-vite build
npm test             # round-trip + service/unit checks
npm run rebuild      # after Electron/Node upgrades (better-sqlite3)
npm run check:release  # public-release gate
```

## 6. Open-source scope

`scripts/check-public-release.mjs` is a hard gate. Do not reintroduce:

- RAG / onnxruntime / transformers.js / sqlite-vec
- MCP server entrypoints
- Private connector plugins outside the allowlist
- COS / proprietary cloud sync

See [ADR-0008](./docs/adr/0008-search-first-ai-instead-of-rag.md).

## Related

- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)
- [docs/ABSTRACTIONS.md](./docs/ABSTRACTIONS.md)
- [docs/adr/README.md](./docs/adr/README.md)
- [.cursor/skills/create-adr/SKILL.md](./.cursor/skills/create-adr/SKILL.md)
