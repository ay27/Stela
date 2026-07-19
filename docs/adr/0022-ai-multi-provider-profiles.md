---
type: ADR
id: "0022"
title: "AI multi-provider profiles via pi-ai builtins + custom createProvider"
status: active
date: 2026-07-18
---

## Context

Stela AI previously stored a single OpenAI-compatible endpoint (`baseUrl` / `model` / one API key shard) and routed every call through a Stela-owned `createProvider` wrapper. Users need multiple providers (DeepSeek, MiniMax, OpenAI, gateways, …) and a way to switch them from the Agent panel. `@earendil-works/pi-ai` already ships built-in provider factories and model catalogs; maintaining a Stela allowlist would duplicate that catalog.

## Decision

**Persist multiple AI profiles per vault (`ai.profiles` + `ai.activeProfileId`), map `vendorId` to pi-ai built-in provider ids (or `custom`), and build transport with the matching pi provider factory—or `createProvider` + `openAICompletionsApi` for custom. Expose every pi built-in provider in Settings (no Stela allowlist). API keys stay in per-profile safeStorage shards.**

## Options considered

- **Single endpoint forever**: simplest code — fails multi-provider UX.
- **Stela-maintained vendor allowlist + hand-written model tables**: controllable UX — duplicates pi catalogs and drifts on bumps. Rejected.
- **pi builtins for all known vendors + custom createProvider** (chosen): zero vendor catalog maintenance; Custom covers arbitrary OpenAI-compatible gateways; secrets remain Stela-owned.

## Consequences

- Settings shape grows (`profiles`, `activeProfileId`); flat `baseUrl` / `model` / `hasApiKey` / `contextWindow` remain as mirrors of the active profile for migration and callers.
- Secret files become `ai_{deviceSlug}_{profileId}.json`; legacy `ai_{deviceSlug}.json` is migrated once.
- Agent/Action use the active profile’s pi API (`openai-completions`, `openai-responses`, `anthropic-messages`, …) — Electron may load more lazy API chunks than the old completions-only path.
- Providers that need OAuth or cloud ambient credentials may fail until configured; no preventive hide-list (fail and surface the error).
- Re-evaluate if: pi removes a provider id users rely on, or profile secrets must sync across devices (today device-local).
