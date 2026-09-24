---
type: ADR
id: "0116"
title: "Official analytics connectors and local file sources"
status: active
date: 2026-09-23
---

## Context

Stela bundles MySQL, PostgreSQL and MongoDB, but its data-analysis workflow needs local file engines and dedicated analytical-database dialects. A transport-compatible connection alone does not provide accurate schema discovery, completion, or Agent SQL behavior. The public-release gate allowlists bundled plugins explicitly.

## Decision

Add official connector plugins through the existing module SDK and registry without changing IPC or the plugin protocol. Use one connector kind per user-visible engine. Reuse MySQL transport for StarRocks while declaring a distinct StarRocks dialect. Give DuckDB a local-file source entry for DuckDB databases, CSV, Parquet, JSON and JSONL. Keep vendor credentials in the existing connection secret store. Cloud engines must expose their own query lifecycle and billing controls before being bundled.

## Options considered

- **Existing plugin protocol (chosen):** supports installation, schema discovery and Agent execution without a new trust boundary.
- Generic JDBC/ODBC bridge: broad driver coverage but a new runtime and authentication surface.
- Treat every compatible engine as MySQL/PostgreSQL: quick connection but incorrect dialect and metadata behavior.

## Consequences

Native DuckDB and SQLite drivers require packaged binaries for macOS and Windows. Each official plugin needs a built artifact, packaging entry, release allowlist and execution/schema tests. Cloud plugins require account-specific live validation before public claims of full support. Local files are selected explicitly and are not silently read from the vault.
