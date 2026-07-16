# Abstractions

Key abstractions and domain models in Stela.

## Design Philosophy

Stela's abstractions follow **convention over configuration**: standard frontmatter fields, `runsql` fences, and `<detail>` blocks have well-defined meanings and trigger UI behavior automatically. A vault that follows these conventions is legible to both humans and AI agents without custom setup.

The full design principles are in [ARCHITECTURE.md](./ARCHITECTURE.md#design-principles).

## Stela Note File

A Stela data note is a standard Markdown file (`.md`) with optional YAML frontmatter. There is no separate `StelaDocument` type in code — the file is split into `frontmatter` + `body` at read time (`src/core/markdown.ts`).

### Frontmatter conventions

| Field | Meaning | UI behavior |
|-------|---------|-------------|
| `type: stela-data-note` | Marks a data note | File tree icon, export eligibility |
| `connection_name:` | Default database connection | RunSQL blocks inherit this connection |
| `created_at:` | Creation timestamp | Metadata display |
| `last_modification:` | Last edit timestamp | Metadata display |

Frontmatter parsing is intentionally minimal (`electron/shared/frontmatter.ts`) — key-value lines only, no full YAML parser dependency.

### RunSQL block shape

Each executable SQL block in a note follows this on-disk pattern:

````markdown
说明文本（可选）

```runsql
SELECT status, COUNT(*) AS total FROM tasks GROUP BY status;
```

<detail>
   <block-id>blk_abc123</block-id>
   <run-date>2026-04-03 12:23:34</run-date>
   <elapsed>1.42s</elapsed>
   <row-count>10</row-count>
   <first-row>{"status":"open","total":42}</first-row>
   <result-ref-id>run_20260403_abc123</result-ref-id>
</detail>
````

Rules:

- `<detail>` **always** describes the **latest successful run** only
- `result-ref-id` points to the full result set in SQLite/JSONL
- `block-id` is stable across re-executions; used for history and diff
- History browsing and version comparison are **UI-only state** — they do not write back to Markdown

### File extension

```typescript
// src/core/stela-file.ts
export const STELA_EXTENSIONS = [".md"];
export const DEFAULT_STELA_EXTENSION = ".md";
```

Legacy `.mdstela` files from earlier versions are still readable if present, but new notes use `.md`.

## DetailMeta

The parsed form of a `<detail>` HTML block. **Single canonical implementation** in `electron/shared/detail-meta.ts`; renderer re-exports from `src/editor/runsql/detail-meta.ts`.

```typescript
interface DetailMeta {
  blockId?: string;
  runDate: string;       // display timestamp
  elapsed: string;       // human-readable duration
  rowCount: number;
  firstRow: Record<string, unknown> | null;  // JSON object for quick preview
  resultRefId: string;   // FK into SQLite runs table
}
```

Serialization preserves `detailRaw` verbatim during editing to avoid JSON whitespace drift. Only successful runs rewrite `detailRaw` via `serializeDetail()`.

## RunRecord and Storage

### RunRecord

One SQL execution, stored in SQLite and mirrored in JSONL.

```typescript
// electron/shared/types.ts, src/contracts/storage.ts
interface RunRecord {
  runId: string;
  blockId: string;
  sql: string;
  status: "ok" | "err" | "running";
  message: string | null;
  startedAt: number;      // Unix epoch ms
  elapsedMs: number;
  rowCount: number;
  connectionName: string;
  notePath: string | null; // vault file that triggered the run
}
```

### SQLite schema (disposable cache)

| Table | Role | Key |
|-------|------|-----|
| `runs` | Execution summary | `run_id` |
| `result_schemas` | Column definitions | `(run_id, ordinal)` |
| `result_rows` | Row data as JSON arrays | `(run_id, row_index)` |
| `journal_cursors` | JSONL import byte offsets | `source_path` |

Implementation: `electron/services/result-store.ts` (better-sqlite3, main process only).

### IStorage (renderer contract)

```typescript
// src/contracts/storage.ts
interface IStorage {
  open(vaultPath: string): Promise<void>;
  saveRun(record: RunRecord): Promise<void>;
  saveSchema(runId: string, columns: ColumnDef[]): Promise<void>;
  saveRows(runId: string, rows: unknown[][]): Promise<void>;
  queryPage(runId: string, offset: number, limit: number): Promise<RowsPage>;
  getSchema(runId: string): Promise<ColumnDef[]>;
  listRuns(): Promise<RunRecord[]>;
  listRunsByBlockId(blockId: string, options?): Promise<RunRecord[]>;
  cleanup(keepDays: number): Promise<number>;
}
```

Renderer adapter: `src/services/storage/electron-storage.ts` → `window.stela.storage.*`.

### JSONL execution history (authoritative)

Append-only, per-device files at `{vault}/.stela/history/history_{deviceSlug}.jsonl`. Each line is a complete run package (record + schema + rows). Git-synced; import cursor tracked in SQLite `journal_cursors`.

Implementation: `electron/services/history-journal.ts`.

## Connection Model

### ConnectionEntry

```typescript
// electron/shared/types.ts
interface ConnectionEntry {
  kind: string;           // connector plugin kind ("mysql", "postgresql", …)
  config: Record<string, unknown>;  // non-secret fields only
  schemaDir?: string;     // optional local schema dump directory
}
type ConnectionMap = Record<string, ConnectionEntry>;  // keyed by connection name
```

Persistence:

- Definitions: `{vault}/.stela/connections.json` (Git-synced)
- Secrets: `{vault}/.stela/secrets/secrets_{deviceSlug}.json` (safeStorage-wrapped, per-device)

Renderer state: `src/state/connections.ts` (Zustand cache keyed by connection name).

### IConnectorRegistry (renderer contract)

```typescript
// src/contracts/connector.ts
interface IConnectorRegistry {
  listKinds(): Promise<ConnectorKindMeta[]>;
  test(kind: string, config: unknown): Promise<TestResult>;
  execute(kind: string, config: unknown, sql: string): Promise<QueryResult>;
  listDatabases(kind: string, config: unknown): Promise<string[]>;
  listTables(kind: string, config: unknown, database: string): Promise<TableInfo[]>;
  // … plugin management methods
}
```

Adapter: `src/services/connectors/registry.ts` → `window.stela.connector.*`.

### QueryResult

```typescript
type QueryResult =
  | { kind: "query"; columns: ColumnDef[]; rows: unknown[][]; elapsedMs: number }
  | { kind: "mutation"; affectedRows: number; elapsedMs: number };
```

## Connector Plugins

### Plugin sources

```typescript
type PluginSource = "builtin" | "subprocess" | "module";
```

| Source | Loader | Location |
|--------|--------|----------|
| `module` | `module-loader.ts` (createRequire) | `{vault}/.stela/plugins/<id>/` |
| `subprocess` | `subprocess.ts` (stdio JSON-RPC) | `connector_plugins.json` → `exe_path` |
| `builtin` | (legacy enum value; v0.5+ core has none) | — |

### ConnectorKindMeta

```typescript
interface ConnectorKindMeta {
  kind: string;
  displayName: string;
  configSchema: unknown;    // JSON Schema for settings UI
  defaultConfig: unknown;
  subprocess: boolean;
  dialect?: string;         // "MySQL", "PostgreSQL", etc.
}
```

### Plugin SDK

Third-party module connectors publish against `plugin-sdk/`:

```typescript
// plugin-sdk/src/index.ts
export interface StelaConnectorPlugin {
  meta: ConnectorKindMeta;
  test(config: unknown): Promise<TestResult>;
  execute(config: unknown, sql: string): Promise<QueryResult>;
  listDatabases?(config: unknown): Promise<string[]>;
  listTables?(config: unknown, database: string): Promise<TableInfo[]>;
}
```

## AppSettings

Vault-scoped settings persisted to `{vault}/.stela/settings.json`.

```typescript
// src/contracts/settings.ts
interface AppSettings {
  vault: VaultSettings;           // recentFiles (→ recent-files.local.json)
  appearance: AppearanceSettings; // theme: light | dark | system
  execution: ExecutionSettings;   // onError, maxRows (result-row cap; SQL unchanged)
  persistence: PersistenceSettings; // cleanupMonths
  ui: UISettings;                 // defaultPageSize, editorWidth
  git: GitSettings;               // enabled, autoCommit, autoPush, autoPull
  ai: AiSettings;                 // provider, model, agent mutation policy
}
```

`execution.maxRows` limits how many query rows Stela saves and displays after a connector returns. It does not rewrite user SQL or append dialect-specific `LIMIT` clauses; `0` means unlimited.

Machine-scoped cache (`{userData}/stela-cache.json`):

```typescript
interface UserCache {
  lastVaultPath: string | null;
  recentVaults: string[];
  locale: string;
}
```

## Vault Index (Wiki Graph)

In-memory derived index for wikilink navigation. Not persisted to disk.

```typescript
// electron/shared/types.ts (simplified)
interface IndexCandidate {
  path: string;
  title: string;
  headings: { slug: string; text: string; level: number }[];
}

interface IndexBacklinkEntry {
  sourcePath: string;
  sourceTitle: string;
  context: string;       // surrounding text snippet
}
```

- Built by `electron/services/vault-index.ts` on vault open
- Incrementally updated via `vault-watcher` events
- Exposed to renderer via `window.stela.index.*`
- UI: wiki autocomplete (`src/editor/wiki/`), backlinks in sidebar

## SQL Fact Index

In-memory derived index for structured SQL search. Extracts AST facts (tables, columns, join patterns) from `runsql` blocks across the vault.

```typescript
interface SqlIndexHit {
  path: string;
  blockId: string;
  sql: string;
  tables: string[];
  runDate: string | null;  // from latest <detail>
  score: number;
}

interface SqlIndexFilter {
  tables?: string[];
  keywords?: string[];
  connectionName?: string;
  dateFrom?: string;
  dateTo?: string;
}
```

- Built by `electron/services/sql-index.ts`
- Uses shared `electron/shared/sql-facts.ts` for AST extraction
- UI: `SqlSearchView.tsx` + AI `parseSqlQuery` enrichment

## Result Diff

Pure renderer function for comparing two execution result sets.

```typescript
// src/services/result-diff.ts
function computeResultDiff(
  left: DiffInput,
  right: DiffInput,
  options: { keyColumns?: string[]; rowCap?: number }
): DiffResult;
```

Row alignment: user-specified key columns → auto-inferred unique columns → positional fallback. Used by BlockResult compare mode and Markdown export diff summaries.

## AI Abstractions

Canonical types live in `electron/shared/types.ts`. Secrets and HTTP stay in `electron/services/ai/`.

### AiSettings

```typescript
type AiProviderMode = "disabled" | "openai-compatible" | "cloud";

interface AiSettings {
  providerMode: AiProviderMode;
  baseUrl: string;                 // chat/agent endpoint root
  model: string;
  hasApiKey: boolean;              // never the raw key
  sendResultSamples: boolean;
  maxSampleRows: number;
  contextWindow: 64_000 | 128_000 | 200_000 | 256_000 | 1_000_000; // compaction budget
  agentMaxIterations: number;      // legacy compatibility; ignored by harness agent
  agentWallClockMs: number;        // legacy compatibility; ignored by harness agent
  agentAllowMutations: boolean;    // still requires per-call user approve
}
```

API key shard: `{vault}/.stela/secrets/ai_{deviceSlug}.json` (safeStorage-wrapped). Transport: `@earendil-works/pi-ai` custom OpenAI-compatible provider; agent loop: `AgentHarness` ([ADR-0018](./adr/0018-pi-ai-agent-harness.md)).

### Action complete

```typescript
type AiActionKind =
  | "rewrite-sql" | "ask-sql" | "generate-sql" | "explain-sql"
  | "optimize-sql" | "debug-query"
  | "explain-result" | "summarize-diff" | "find-anomalies"
  | "write-analysis" | "rewrite-selection" | "add-limitations"
  | "explain-table" | "suggest-joins" | "generate-data-dictionary"
  | "find-related-queries";

type AiContextSource = "runsql" | "result" | "editor" | "schema";

interface AiRequestContext {
  source: AiContextSource;
  notePath?: string | null;
  noteMarkdown?: string | null;
  connectionName?: string | null;
  connector?: AiConnectorContext | null;
  sql?: string | null;
  selectedText?: string | null;
  errorMessage?: string | null;
  result?: AiResultContext | null;       // sampled rows only
  schemas?: AiSchemaTargetContext[];
  mentionedTables?: string[];            // from @table mentions in the prompt UI
  userInstruction?: string | null;
}

interface AiCompleteRequest {
  action: AiActionKind;
  locale?: "zh" | "en";
  context: AiRequestContext;
}
```

Pipeline: enrich schema → cap sizes → optional samples → `redactForPrompt` → action prompt → pi-ai `completeSimple`. See [ADR-0018](./adr/0018-pi-ai-agent-harness.md), [ADR-0014](./adr/0014-ai-context-redaction-and-schema-enrichment.md).

### SQL query parse (NL → filter)

```typescript
interface AiParseSqlQueryRequest {
  question: string;
  locale?: "zh" | "en";
}

interface AiParseSqlQueryResponse {
  filter: SqlIndexFilter;  // model translation only
  warnings: string[];
}
```

Hits always come from deterministic `sql-index` intersection — the model must not invent table names.

### Agent harness

```typescript
type AgentToolName =
  | "list_databases" | "list_tables" | "search_tables" | "get_table_schema"
  | "run_sql"
  | "search_vault" | "list_vault_files" | "read_note"
  | "propose_edit";

interface AgentRunRequest {
  runId: string;
  sessionId?: string;          // in-memory multi-turn history
  prompt: string;
  connectionName?: string | null;
  mentionedTables?: string[];
  referencedNotes?: string[];  // vault-relative note paths from [[...]] / current note chips
  attachments?: Array<
    | { kind: "selection"; label: string; text: string; sourcePath?: string }
    | { kind: "runsql"; label: string; sql: string; sourcePath?: string }
  >;
  notePath?: string | null;
  locale?: "zh" | "en";
}

type AgentEvent =
  | { type: "started"; runId: string }
  | { type: "assistant_message"; runId: string; content: string }
  | { type: "tool_call"; runId: string; call: AgentToolCallInfo }
  | { type: "tool_result"; runId: string; callId: string; ok: boolean; summary: string }
  | { type: "proposal"; runId: string; callId: string; kind: "edit_note" | "mutation_sql"; payload: AgentProposalPayload }
  | { type: "context_usage"; runId: string; usedTokens: number; contextWindow: number; estimated: boolean }
  | { type: "compaction"; runId: string; phase: "started" | "completed" }
  | { type: "final"; runId: string; content: string }
  | { type: "error"; runId: string; message: string }
  | { type: "cancelled"; runId: string };
```

Safety ([ADR-0013](./adr/0013-agent-tools-sql-guard-and-proposals.md)):

- `sql-guard` classifies read-only vs mutation vs multi-statement
- Mutations + `propose_edit` block on `ai:agent-respond-proposal`
- Runs continue until model completion, error, or explicit user cancellation ([ADR-0017](./adr/0017-user-cancelled-agent-runs.md))
- Tools use `executionMode: "parallel"` except `propose_edit` (`"sequential"`) ([ADR-0021](./adr/0021-parallel-agent-tools-except-propose-edit.md)). NodeExecutionEnv is harness cwd only (not exposed as model tools)
- Compaction uses `ai.contextWindow` + one overflow recovery ([ADR-0018](./adr/0018-pi-ai-agent-harness.md))
- Note references are paths only; the agent should call `read_note` before relying on note contents
- Selection / RunSQL attachments are bounded and included only on the user turn that added them

### UI entry points

| Surface | Location | Backend |
|---------|----------|---------|
| RunSQL rewrite / ask | `codeblock-nodeview` + `ai-inline-panel` | `ai:complete` |
| Schema actions | `SchemaBrowserPanel` + `ai-modal` | `ai:complete` |
| Agent chat | `AgentSidebar` / `agent-panel` | `ai:agent-run` + events |
| `@table` mentions | `table-mention-input` | `mentionedTables` on requests |
| `[[note]]` references | `agent-panel` prompt chips | `referencedNotes` on `ai:agent-run` |
| Add to Chat | editor context menu / `Mod+I` | `attachments` on `ai:agent-run` |
| Settings | `settings/ai-tab` | `ai:configure` / `clearApiKey` |

## IPC Error Model

```typescript
// electron/shared/errors.ts
interface IpcErrorPayload {
  code: string;       // machine-readable, e.g. "vault_outside", "connector_timeout"
  message: string;    // human-readable
  retryable?: boolean;
}
```

Renderer parsing: `src/lib/ipc-error.ts`. IPC rejections carry `[code] message` in the Error message string — not Error class instances.

## Renderer State Stores

Zustand stores in `src/state/`:

| Store | File | Holds |
|-------|------|-------|
| Workspace | `workspace.ts` | Open tabs, active file, vault path |
| Settings | `settings.ts` | Cached AppSettings |
| Connections | `connections.ts` | ConnectionMap cache |
| Git | `git.ts` | Status, modified files, sync state |
| Search | `search.ts` | Vault search keyword + hits |
| SQL search | `sql-search.ts` | SQL index query + results |
| Layout | `layout.ts` | Panel widths, sidebar visibility |
| Dialogs | `dialogs.ts` | Modal open flags (settings, connections, export, palette) |
| Agent | `agent-panel.ts` | AI agent session state |

Global dialog pattern: modals mount at `AppShell` root, triggered via `dialogs.ts` store — prevents sidebar unmount from closing open dialogs.

## Event Flow (External Changes)

```
vault-watcher (chokidar, main)
    │ vault:external-change { paths, kind }
    ▼
renderer subscriber (vault-watcher-subscriber.ts)
    ├── clean tab → reload file content
    ├── dirty tab → conflict prompt (no silent overwrite)
    └── vault-index / sql-index incremental rebuild
```

## Naming Map (legacy → current)

| Legacy name (old docs / Tauri era) | Current name |
|-------------------------------------|--------------|
| `StelaDocument` | `.md` file split into frontmatter + body |
| `ConnectionConfig` | `ConnectionEntry` |
| `IStorage` (Rust SqliteStore) | `IStorage` (better-sqlite3 via IPC) |
| `tauri-storage.ts` | `electron-storage.ts` (filename retained for git history) |
| `.mdstela` extension | `.md` (`.mdstela` still readable) |
| COS sync | Git + JSONL sync |
| RAG / knowledge base | Search-first AI (no embedding runtime in OSS) |

## Related Documents

- [ARCHITECTURE.md](./ARCHITECTURE.md) — system architecture and data flow
- [adr/](./adr/) — decision records for each major choice above
