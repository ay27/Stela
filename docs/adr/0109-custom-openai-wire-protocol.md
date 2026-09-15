---
type: ADR
id: "0109"
title: "Explicit Custom OpenAI wire protocol"
status: active
date: 2026-09-15
---

## Context

Some OpenAI-compatible gateways require Responses for reasoning with function tools. Custom profiles previously always selected Chat Completions; disabling reasoning omitted the parameter and could leave server defaults enabled.

## Decision

Custom profiles select `chat-completions` or `responses` through optional `customApi`. Missing values retain Chat Completions. Reuse pi-ai's matching provider adapter for requests, streaming and tool-result replay. Explicit off maps to `none` in the selected protocol; do not silently downgrade reasoning or retry with a different protocol. Built-in provider behavior stays catalog-owned.

## Options considered

- Explicit protocol selection (chosen): deterministic and compatible with old settings.
- Infer from model name or retry after rejection: ambiguous gateway capabilities and hidden behavior changes.

## Consequences

The profile setting crosses existing typed, validated settings IPC. Users must select a protocol their gateway supports. Explicit `none` can be rejected by gateways that do not support standard reasoning controls; such errors remain visible. No new dependency or credential storage is introduced.
