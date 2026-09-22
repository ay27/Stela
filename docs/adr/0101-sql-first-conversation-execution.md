---
type: ADR
id: "0101"
title: "Sql first conversation execution"
status: active
date: 2026-09-10
---

## Context

Users need a durable workspace combining SQL editing and analytical conversation.

## Decision

Main owns conversation submission, SQL-first routing, execution, proposals and persistence. Pure SQL avoids model calls; mixed input and query repair use the existing AgentHarness and shared mutation gates.

## Options considered

- Dedicated conversation file and existing harness (chosen): durable, portable context and reusable execution.
- Agent Panel history alone: bounded retention cannot own long-lived documents.

## Consequences

Conversation writes must be atomic and conflict checked. Large conversations increase file size; result rows remain separate. Existing notes and Panel sessions keep their formats.
