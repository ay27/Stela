---
type: ADR
id: "0065"
title: "Session-oriented Agent observability projection"
status: active
date: 2026-08-14
---

## Context

The local observability database stores root Agent runs, child tool and Skill
maintenance runs, and ordered redacted events. Agent conversation history
already stores the authoritative device-sharded Session and user-run order.
The original Dashboard exposed metrics as aggregate tables and flat run traces,
which made a multi-step Agent execution difficult to understand.

## Decision

**Project Agent History and local Metrics together at read time: History owns
Session and user-Turn order, while Metrics owns model-step, tool, timing, token,
and payload diagnostics linked by run id.** Do not duplicate Session or Turn
records in the Metrics database. Expose a typed Session-trace IPC method that
returns each history run with its complete local metric run tree.

New Agent runs record bounded model-request, first-token, assistant-message,
and step-boundary timing events. Older traces remain readable with unavailable
or inferred timing clearly distinguished from recorded timing.

## Options considered

- **Read-time History + Metrics projection** (chosen): preserves one authority
  for conversation order and one for local diagnostics, without a migration.
- **Normalize Session and Turn columns into Metrics**: makes metric-only queries
  easier, but duplicates history authority and requires consistency repair.
- **Build the hierarchy only in the renderer**: avoids a new IPC method, but
  requires many per-run IPC calls and leaks storage-join rules into UI code.

## Consequences

- Dashboard Sessions are local diagnostic views; other-device history remains
  available in the Agent Panel but has no implied local trace.
- Clearing or expiring Metrics does not delete conversation history. The
  Session view continues to show the conversation and marks its trace missing.
- Aggregate Overview metrics, retention, redaction, payload limits, and the
  existing flat trace APIs remain unchanged.
- The Session trace is manually refreshed; no background polling is introduced.
- Re-evaluate if Metrics become synchronized across devices or Session history
  retention grows enough to require paginated Session projections.
