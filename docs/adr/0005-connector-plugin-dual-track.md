---
type: ADR
id: "0005"
title: "Connector plugin dual track (module + subprocess)"
status: active
date: 2026-04-10
---

## Context

Stela must connect to MySQL, PostgreSQL, HTTP gateways, and arbitrary future databases. Built-in in-process connectors (v0.4) coupled the core release cycle to database driver updates and created a large attack surface. Third-party connectors need different trust levels.

## Decision

**Remove all built-in in-process connectors from core.** Ship official connectors as **module plugins** (in-process JS, full Node permissions, installed to `{vault}/.stela/plugins/`). Support **subprocess plugins** (stdio JSON-RPC, process-isolated) for third-party and arbitrary-language connectors. Both register through a unified `ConnectorRegistry`.

## Options considered

- **Built-in connectors in main** (v0.4): zero setup, but core bloat and security coupling. Removed in v0.5.
- **Subprocess only**: maximum isolation, but latency overhead and complex debugging for official connectors. Rejected as sole path.
- **Module + subprocess dual track** (chosen): official connectors get performance; third-party gets isolation.

## Consequences

- Bundled plugins (MySQL, PostgreSQL, HTTP sample) ship in `extraResources` and seed on first vault open
- `plugin-sdk/` publishes a stable contract for module plugin authors
- Subprocess plugins: line-delimited JSON-RPC, `hello` handshake, 5 methods (`test/execute/list_databases/list_tables/shutdown`)
- Module plugins: `createRequire` dynamic load, hot-reload on vault switch
- Open-source release gates allowlist only 3 bundled plugin directories
- Triggers re-evaluation if: Electron sandbox or utilityProcess APIs mature enough to replace subprocess JSON-RPC with less boilerplate
