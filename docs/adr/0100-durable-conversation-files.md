---
type: ADR
id: "0100"
title: "Durable conversation files"
status: active
date: 2026-09-10
---

## Context

Users need a durable workspace combining SQL editing and analytical conversation.

## Decision

SQL conversations are versioned .stela.chat Vault files containing committed turns and Agent session storage. Query rows remain in the execution journal and result cache. They do not participate in disposable Agent history retention.

## Options considered

- Dedicated conversation file and existing harness (chosen): durable, portable context and reusable execution.
- Agent Panel history alone: bounded retention cannot own long-lived documents.

## Consequences

Conversation writes must be atomic and conflict checked. Large conversations increase file size; result rows remain separate. Existing notes and Panel sessions keep their formats.
