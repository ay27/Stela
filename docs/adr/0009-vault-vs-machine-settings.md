---
type: ADR
id: "0009"
title: "Vault-scoped vs machine-scoped settings boundary"
status: active
date: 2026-04-05
---

## Context

Stela settings include appearance, execution limits, Git sync preferences, AI configuration, and connection definitions. Some settings should travel with the vault (shared across devices via Git); others are machine-specific (window layout, device identity, decryption keys).

## Decision

**Vault-scoped settings live in `{vault}/.stela/settings.json` and are Git-synced.** **Machine-scoped state lives in `{userData}/`** (`stela-cache.json`, `device-profile.json`) or in vault-local-but-gitignored files (`recent-files.local.json`, `secrets_{slug}.json`). Connection passwords use per-device `safeStorage` wrapping in `secrets_{slug}.json` — ciphertext syncs via Git but decrypts only on the originating machine.

## Options considered

- **All settings in userData**: simple, but settings don't follow the vault across machines. Rejected.
- **All settings in vault**: connections portable, but passwords would need plaintext or shared keyring. Rejected.
- **Split vault / machine** (chosen): settings and connection definitions follow vault; secrets and device identity stay local.

## Consequences

- `settings-store.ts` reads/writes per current vault (routed by `vault-context.ts`)
- `user-cache-store.ts` holds `lastVaultPath`, `recentVaults`, `locale` across vaults
- `device-profile.json` provides stable `deviceSlug` for JSONL filename
- Dev mode uses isolated `Stela-dev` userData to avoid single-instance lock conflicts
- Triggers re-evaluation if: a unified settings sync layer (e.g. OS keychain + cloud prefs) simplifies the split
