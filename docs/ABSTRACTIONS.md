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

### SQL Template file

A SQL template is a hidden Vault Markdown file at
`.stela/sql-templates/<stable-slug>.md`. It uses `type: stela-sql-template`,
`name`, `description`, and `connection_name` frontmatter. The first `runsql`
fence is the insertion payload. `{{variable}}` placeholders remain visible,
repeated names edit together, `Tab` / `Shift+Tab` move between variables, and
`Escape` ends variable editing.

New templates begin as recoverable, locally timestamped
`template-YYYYMMDD-HHmmss[-N].md` drafts with blank `name` and `description`;
both fields are edited above the normal note editor. Closing a draft with
incomplete metadata asks for confirmation. If the user closes it anyway, a
missing name is persisted as the stable `Untitled [N]` fallback while
description may remain blank. The library also derives that fallback from the
filename so an incomplete draft remains discoverable after an unexpected app
exit.

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

An Analysis Canvas is a separate ordinary Vault file ending in
`.stela.canvas`. It is structured JSON rather than Markdown and opens in the
Canvas workspace; analysis content is Agent-owned while the user may adjust
Flow layout. See `AnalysisCanvas` below.

Other recognized source and plain-text files are ordinary editable Vault files,
not Stela notes. Workspace rendering derives one of four modes from the path:

```typescript
type WorkspaceFileMode = "markdown" | "source" | "analysis" | "unsupported";
```

Source mode uses CodeMirror and preserves physical line separators. Unknown
extensions and binary-like text are not editable. A source file is deliberately
excluded from implicit `AgentWorkspaceContext`, whose public contract remains
`note | canvas`.

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

Serialization preserves `detailRaw` verbatim during ordinary editing. Detail is
execution metadata only; charts and other presentation state never enter a
RunSQL block or note Markdown.

## RunRecord and Storage

### RunRecord

One SQL or structured MongoDB execution, stored in SQLite and mirrored in JSONL.

```typescript
// electron/shared/types.ts, src/contracts/storage.ts
interface RunRecord {
  runId: string;
  blockId: string;
  sql: string;              // SQL text or canonical structured-query JSON
  queryLanguage?: "sql" | "mongodb"; // old rows/packages default to sql
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

### StelaChartSpec

Analytical charts are versioned JSON. The shared Zod schema in
`electron/shared/chart-spec.ts` is the single parser for Agent output, Canvas
rendering, and export. Version 2 uses a Stela-owned analytical `preset`, named
semantic `fields`, and one or two controlled `layers`. Presets are `trend |
ranking | composition | distribution | correlation | funnel | retention |
comparison | custom`; marks are `bar | line | area | point | arc | rect | rule |
histogram | boxplot | funnel`. Encodings reference field ids rather than
containing rows or executable expressions. Two-layer comparison/custom charts
share x and may use left/right y axes.

`source.kind = "run"` pins a rendered chart to one audited execution. Agent
timeline charts carry this source directly. A Canvas stores the source-free
chart configuration on its card, then supplies the current run from the card's
referenced Canvas source. Missing cache data may be restored by exact run id
from the JSONL journal.

The validator rejects unknown properties, invalid preset/mark/channel
combinations, missing or wrongly typed fields, empty results, more than 5,000
rows, duplicate analytical keys, and type-specific category/cell limits.
Aggregation and business calculations belong in SQL; charts do not silently
sample results. `ValueFormat` is shared by chart fields, KPI values, and table
columns and covers auto/text, numeric/compact, percent, currency, date/time,
duration, boolean, and custom null labels
([ADR-0057](./adr/0057-bounded-mark-encoding-visualizations.md)).

### AnalysisCanvas

A `*.stela.canvas` file is a versioned, strict JSON artifact validated by
`electron/shared/analysis-canvas.ts`:

```typescript
interface AnalysisCanvas {
  kind: "stela-analysis-canvas";
  version: 1;
  id: string;
  title: string;
  status: "working" | "complete" | "error";
  createdAt: number;
  updatedAt: number;
  createdBySessionId: string | null;
  sources: AnalysisCanvasSource[];
  sections: AnalysisCanvasSection[];
}

interface AnalysisCanvasSource {
  id: string;
  title: string;
  connectionName: string;
  sql: string;                 // read-only, table-backed re-analysis definition
  lastRunId: string | null;    // exact run in SQLite/JSONL, never result rows
  lastRunAt: number | null;
  lastError: { message: string; attemptedAt: number } | null;
}

type AnalysisCanvasCard =
  | { type: "markdown"; id: string; markdown: string; width: CanvasCardWidth }
  | { type: "kpi"; id: string; sourceId: string; value: FormattedField; width: CanvasCardWidth }
  | { type: "chart"; id: string; sourceId: string; chart: StelaChartConfig; width: CanvasCardWidth }
  | { type: "table"; id: string; sourceId: string; columns?: FormattedField[]; maxRows: number; width: CanvasCardWidth }
  | { type: "flow"; id: string; direction: "TB" | "LR"; nodes: FlowNode[]; edges: FlowEdge[]; width: CanvasCardWidth };

interface FormattedField {
  field: string;
  title?: string;
  format?: ValueFormat;
}

interface FlowNode {
  id: string;
  kind: "step" | "decision" | "source" | "result" | "note";
  label: string;
  description?: string;
  tone?: "neutral" | "info" | "success" | "warning" | "danger";
  position?: { x: number; y: number };
}

interface FlowEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  tone?: "neutral" | "success" | "warning" | "danger";
}
```

Source, section, and card ids are unique and stable; every data-backed card must
reference an existing source. Canvas services enforce Vault confinement, atomic
writes, and etag conflicts. A source must be a table-backed `SELECT`/`WITH`
query; constant `SELECT`, `VALUES`, and literal `UNION` snapshots are rejected
because rerunning them cannot observe source-data changes. Whole-Canvas and
single-source refresh actions immediately start a dedicated Agent run. The
Agent may commit the complete validated artifact once, only after every target
source is rebound to a successful query from that same run; otherwise the
Canvas remains byte-for-byte unchanged and the failure stays in execution and
Agent history. Successful updates preserve existing Flow layout by stable ids.
Users may export, drag Flow nodes, switch TB/LR direction, and auto-layout, but
cannot edit graph semantics. Layout writes remain a narrow typed IPC mutation
with etag conflict detection. The version 1 `lastError` field remains readable
for compatibility and is cleared when its source is successfully rebound
([ADR-0056](./adr/0056-user-adjustable-react-flow-cards.md),
[ADR-0070](./adr/0070-agent-led-atomic-canvas-refresh.md)).

### JSONL execution history (authoritative)

Append-only, per-device files at `{vault}/.stela/history/history_{deviceSlug}.jsonl`. Each line is a complete run package (record + schema + rows). Git-synced; import cursor tracked in SQLite `journal_cursors`.

Implementation: `electron/services/history-journal.ts`.

### GitSyncRequest / GitSyncResult

`window.stela.git.syncNow(request)` is the typed renderer-to-main synchronization
contract. `GitSyncRequest` selects the trigger and permitted operations
(`commit`, `integrate`, `push`); IPC validation requires `push` to imply
`integrate`. The main process serializes requests per Vault.

`GitSyncResult` reports checkpoint/integration/push outcomes, conflict mode,
imported run count, and changed domains. The changed-domain union is
`vault-files | history | agent-history | settings | connections | skills |
templates`. Renderer stores use it to reload clean tabs and affected caches
without replacing dirty editor buffers. `blockedReason` distinguishes dirty
tabs, uncheckpointed local changes, existing/created conflicts, and offline
remote access.

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
  queryLanguages?: Array<"sql" | "mongodb">; // missing means SQL-only
  mongoOperations?: Array<"find" | "aggregate">; // missing means find-only
  queryArtifactFormats?: Array<"parquet" | "jsonl">;
}
```

The Agent-only structured query contract is discriminated by language:

```typescript
type DataQueryRequest =
  | { language: "sql"; query: string; database?: string | null }
  | {
      language: "mongodb";
      operation?: "find";
      database?: string | null;
      collection: string;
      filter?: Record<string, unknown>;
      projection?: Record<string, unknown> | null;
      limit?: number | null;
    }
  | {
      language: "mongodb";
      operation: "aggregate";
      database?: string | null;
      collection: string;
      pipeline: Record<string, unknown>[];
      limit?: number | null;
    };
```

### Plugin SDK

Third-party module connectors publish against `plugin-sdk/`:

```typescript
// plugin-sdk/src/index.ts
export interface Connector {
  meta(): ConnectorKindMeta;
  test(config: unknown): Promise<TestResult>;
  execute(config: unknown, sql: string): Promise<QueryResult>;
  executeQuery?(
    config: unknown,
    query: DataQueryRequest,
  ): Promise<QueryResult>;
  materializeQuery?(
    config: unknown,
    sql: string,
    request: QueryArtifactRequest,
  ): Promise<MaterializedQueryResult | null>;
  materializeDataQuery?(
    config: unknown,
    query: DataQueryRequest,
    request: QueryArtifactRequest,
  ): Promise<MaterializedQueryResult | null>;
  listDatabases?(config: unknown): Promise<string[]>;
  listTables?(config: unknown, database: string): Promise<TableInfo[]>;
}
```

`QueryArtifactRequest.outputPath` is host-selected and visible only inside the
trusted connector/main boundary. A successful materialization writes that path
atomically and returns a bounded preview plus exact `rowCount`; it never returns
the path to renderer or model code. Connectors without the v2 materialization
method continue through the buffered v1 result contract. Plugin API v3 adds
`queryLanguages`, `executeQuery`, and `materializeDataQuery`; absent language
metadata remains SQL-only, so v1/v2 plugins require no migration.
Plugin API v4 adds `mongoOperations` and safe aggregation; absent operation
metadata remains find-only, so v1-v3 plugins require no migration.

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
  ai: AiSettings;                 // provider, model, Agent policies and automatic Skill maintenance
}
```

`AiSettings.automaticSkillMaintenanceEnabled` defaults to `true`. When false,
Stela cancels automatic maintenance, does not enqueue post-answer maintenance,
and withholds stale Skills instead of refreshing them. A direct user-requested
`save_skill` remains available.

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
type AiReasoningEffort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

interface AiProviderProfile {
  id: string;
  name: string;
  vendorId: string;                // pi-ai provider id, or "custom"
  model: string;
  baseUrl: string;                 // required for custom; unused for builtins
  contextWindow: 64_000 | 128_000 | 200_000 | 256_000 | 1_000_000;
  reasoningEffort: AiReasoningEffort; // requested main-Agent effort; default medium
  hasApiKey: boolean;              // never the raw key
}

interface AiSettings {
  providerMode: AiProviderMode;    // global on/off (+ legacy cloud alias)
  activeProfileId: string;
  profiles: AiProviderProfile[];
  inlineCompletionEnabled: boolean;
  completionProfileId: string | null; // independent of activeProfileId
  // mirrors of the active profile (compat)
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  contextWindow: 64_000 | 128_000 | 200_000 | 256_000 | 1_000_000;
  agentMaxIterations: number;      // legacy; ignored by harness agent
  agentWallClockMs: number;        // legacy; ignored by harness agent
  agentAllowMutations: boolean;    // still requires per-call user approve
  agentAutoApplyEdits: boolean;    // default false; note/RunSQL propose_edit only
}
```

Data-analysis runs also maintain an in-memory efficiency ledger
([ADR-0069](./adr/0069-adaptive-agent-strategy-review.md)). It normalizes SQL and
MongoDB calls into advisory query families and may append one immutable
`AgentStrategyCheckpoint` to the pi Session. The checkpoint contains its
trigger, bounded counters, and validated `continue | change` advice; it is not
a user message, a tool authorization decision, or a persisted data result.
`AgentEvent.strategy_review` projects its started/completed/failed lifecycle to
the Panel, while local metrics record the same request as a
`strategy_review` child surface. No new IPC channel or synchronized storage
authority is introduced.

API key shard: `{vault}/.stela/secrets/ai_{deviceSlug}_{profileId}.json` (safeStorage-wrapped). Transport: pi-ai built-in provider for `vendorId`, or `createProvider` for `custom` ([ADR-0022](./adr/0022-ai-multi-provider-profiles.md)); agent loop: `AgentHarness` ([ADR-0018](./adr/0018-pi-ai-agent-harness.md)). Inline completion is enabled only when `completionProfileId` names an existing profile.

`reasoningEffort` is the requested Profile policy. The transport resolves it to
the model's effective supported level before constructing the main Harness;
built-in catalogs expose their supported levels, while Custom non-`off`
selection explicitly declares standard `reasoning_effort` support. Missing
Profile fields migrate to `medium`. Context compaction and strategy review
inherit the effective level; inline completion, quick actions, and Skill
maintenance remain `off` ([ADR-0072](./adr/0072-profile-scoped-agent-reasoning-effort.md)).

### SQL inline completion

```typescript
interface AiInlineCompletionRequest {
  requestId: string;
  prefix: string;
  suffix: string;
  siblingSqls: string[]; // same-note RunSQL blocks, nearest first
  connectionName: string | null;
  tableSchemas?: AiSchemaTargetContext[]; // already-cached renderer columns, ≤8 tables
  heading?: string | null;                // nearest heading above the block
  prose?: string | null;                  // ≤500 chars between heading and block
}

type AiInlineCompletionEvent =
  | { type: "started"; requestId: string }
  | { type: "delta"; requestId: string; text: string }
  | { type: "final"; requestId: string }
  | { type: "error"; requestId: string; message: string }
  | { type: "cancelled"; requestId: string };
```

IPC uses `AI_INLINE_COMPLETION_START`, `AI_INLINE_COMPLETION_CANCEL`, and push event `ai:inline-completion-event`; preload exposes `window.stela.ai.startInlineCompletion`, `cancelInlineCompletion`, and `onInlineCompletionEvent`. Completion uses `completionProfileId` independently of chat/agent `activeProfileId`. Every profile uses the same bounded, reasoning-off, streamed pi-ai Chat transport; there is no provider-specific native FIM route in the application runtime ([ADR-0087](./adr/0087-chat-only-sql-inline-completion.md)).

Schema context comes from two sources: `tableSchemas` carries columns from the renderer `column-cache` for tables in the cursor's FROM/JOIN scope, and main reads parsed columns/comments for referenced tables from the connection's local `schemaDir`. Renderer columns own membership and type; matching schemaDir columns may add comments, while schemaDir-only tables are compact fallback context. Full DDL, engine, distribution, and storage clauses are not sent. Focus still prewarms known tables, and a completion attempt awaits the same TTL-backed per-table ensure before making a paid model call. If any referenced physical table still has no columns in either source, main returns an empty completion without loading the API key.

Completion input is capped near 8K characters: 4K cursor prefix, 2K suffix, and 2K auxiliary context containing at most three tables, two table-related sibling blocks, and 300 prose characters. Automatic requests start only after a document edit has been idle for 250 ms, at any SQL cursor position; cursor movement never calls the model. A parser-clean `SELECT ... FROM ...` at the document tail is automatically treated as complete, while `Alt+\` can manually request an extension there. Empty selections are required, and comments, strings, IME, blur, semicolon-terminated statements, native completion popups, and stale contexts suppress or cancel work. The renderer keeps a 64-entry five-minute LRU for positive and empty results. Candidates are buffered before display, limited to three lines/360 characters, rejected when they fall below the conservative confidence threshold (when logprobs exist), increase parser errors, or introduce a provably absent qualified column. When exactly one referenced table has known columns, the same guard rejects absent bare identifiers such as an invented `WHERE dt = ...`; it declines to guess when a candidate introduces another table. Accepted text is then normalized for repetition, token boundaries, and suffix overlap. The explicit evaluator reports the logprob distribution used to calibrate that threshold against live runs. Tab accepts the visible ghost in one transaction; Escape dismisses it.

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

Agent schema tools have one authority: the selected live connector (the current
note connection by default, or an explicit listed `connectionName`). `search_tables`
enumerates that catalog and `get_table_schema` fetches current DDL or columns;
they do not read the optional connection `schemaDir` dump ([ADR-0041](./adr/0041-agent-live-schema-authority.md)).
Catalog enumeration uses at most four concurrent `listTables` calls and is not
cached. A qualified `database.table` passed to `get_table_schema` is fetched
directly; only an unqualified name enumerates the catalog to resolve its database.
When several qualified tables are requested, their fallback probes run concurrently.

`get_table_schema` returns `columns` as one `name:type` line per column, not a JSON
array of objects: a pretty-printed array costs 12 characters of pure formatting per
column, which alone is 8K on two 300-column tables. Coverage outranks precision, so
column comments are returned only when the call passes `columnNames` (a named set is
the model confirming meaning, not counting shape) and full comments plus full
coverage never both fit for a wide table. `includeDdl` defaults to false because the
snippet re-derives the same column list from the same `SHOW CREATE TABLE`. Each table
reports `totalColumnCount`, `returnedColumnCount`, `columnsComplete`, plus
`nextColumnOffset` and `commentsOmitted` when they apply, and `missingRequestedColumns`
for names that do not exist. Every table gets an equal share of the character budget,
and over budget the drop order is comments, then DDL, then columns — a missing comment
is a precision loss the model can name and re-request with `columnNames`, while a
missing column silently misrepresents the table's width. `parseColumnsFromDdl` keeps
its 80-column default for prompt-embedded catalogs; only this tool raises it. Shedding
precision before coverage, allocating equal per-entity shares, and reporting
completeness per entity rather than as one global marker apply to any bounded tool
payload ([ADR-0082](./adr/0082-coverage-over-precision-in-bounded-tool-results.md)).

When the connector implements `describeTables(kind, config, tables)` the schema
resolver calls it once per lookup and uses the returned `TableDescriptor`
columns (with `comment`) directly. Otherwise it falls back to `SHOW CREATE TABLE`
→ `DESCRIBE` → `SELECT ... LIMIT 0` ladder; old plugins keep working
([ADR-0042](./adr/0042-connector-describe-tables-api.md)). The public HTTP
gateway sample implements the optional API with concurrent `SHOW FULL COLUMNS`
requests capped at four in flight, while gateway-specific private plugins may
provide a true batch endpoint.

```typescript
type AgentToolName =
  | "list_catalog" | "search_tables" | "get_table_schema"
  | "run_query" | "execute_python" | "create_chart" | "search_sql_usage"
  | "create_analysis_canvas" | "read_analysis_canvas" | "update_analysis_canvas"
  | "search_vault" | "list_vault_files" | "read_note"
  | "plan"
  | "search_skills" | "load_skill" | "save_skill"
  | "propose_edit" | "ask_user";

type AgentProposalKind = "edit_note" | "runsql_rewrite" | "mutation_sql" | "question";

interface AgentProposalPayload {
  description: string;
  targetId?: string;   // renderer-owned RunSQL target
  // edit_note / mutation_sql
  notePath?: string;
  oldContent?: string;
  newContent?: string;
  sql?: string;
  // question
  question?: string;
  options?: string[];   // ≤6 clickable answers; free text always allowed
}

interface AgentProposalResponse {
  runId: string;
  callId: string;
  approve: boolean;
  answer?: string;      // question kind; approve=false means declined to answer
}

interface AgentRunRequest {
  runId: string;
  sessionId?: string;          // persisted multi-turn history
  message?: AgentMessageContent; // authoritative for new runs; ordered inline resources
  prompt: string;                // derived plain-text compatibility/title/search form
  workspaceContext?: {           // implicit current tab; not rendered as a pill
    kind: "note" | "canvas";
    path: string;
  };
  entryPoint?: "chat" | "runsql-fix" | "runsql-rewrite" | "runsql-ask" | "schema-explain";
  connectionName?: string | null;
  notePath?: string | null;
  locale?: "zh" | "en";
}

interface AgentMessageContent {
  version: 1;
  segments: Array<
    | { kind: "text"; text: string }
    | { kind: "resource"; resourceId: string }
  >;
  resources: AgentMessageResource[]; // deduplicated bodies; a resource may occur repeatedly
}

type AgentMessageResource =
  | { id: string; kind: "table"; label: string; table: string; connectionName?: string | null }
  | { id: string; kind: "note" | "canvas"; label: string; path: string }
  | { id: string; kind: "selection"; label: string; text: string; sourcePath?: string; locator?: AgentResourceLocator }
  | { id: string; kind: "runsql"; label: string; sql: string; sourcePath?: string; locator?: AgentResourceLocator; rewriteTargetId?: string };

type AgentPlanStepStatus = "pending" | "running" | "completed" | "blocked" | "skipped";

interface AgentPlanStep {
  id: string;
  title: string;
  intent: string;
  acceptance: string;
  status: AgentPlanStepStatus;
  evidence?: string;
  runId?: string;
}

// Progress bookkeeping for the agent panel; no authority over the answer (ADR-0078).
// Older history may carry `revision` and `analysis` members; both are ignored.
interface AgentPlanSnapshot {
  runId: string;
  version: number;
  steps: AgentPlanStep[];
}

type AgentEvent =
  | { type: "started"; runId: string }
  | { type: "assistant_progress"; runId: string; stepIndex: number; content: string; phase: "streaming" | "completed" }
  | { type: "plan_updated"; runId: string; plan: AgentPlanSnapshot }
  | { type: "tool_call"; runId: string; call: AgentToolCallInfo }
  | { type: "tool_result"; runId: string; callId: string; ok: boolean; summary: string }
  | { type: "proposal"; runId: string; callId: string; kind: AgentProposalKind; payload: AgentProposalPayload }
  | { type: "context_usage"; runId: string; usedTokens: number; contextWindow: number; estimated: boolean }
  | { type: "compaction"; runId: string; phase: "started" | "completed" }
  | { type: "history_updated"; runId: string }
  | { type: "canvas_updated"; runId: string; path: string; title: string; action: "created" | "updated" }
  | { type: "final"; runId: string; content: string; stepIndex?: number }
  | { type: "error"; runId: string; message: string }
  | { type: "cancelled"; runId: string };
```

Tool dispatch keeps two per-run counters on the tool context: `questionsAsked`
caps `ask_user` at three questions, and `toolFailureStreak` maps a tool name to
its consecutive failure count. A tool that reaches three consecutive failures is
blocked for the rest of the run and any success clears its entry; the
exploration tools governed by
[ADR-0069](./adr/0069-adaptive-agent-strategy-review.md) are exempt, and the run
is never terminated
([ADR-0081](./adr/0081-deterministic-tool-failure-circuit-breaker.md)).

Tool validation failures report zod issues as `path: message` pairs, adding the
allowed values when a discriminated union rejected the payload, so a rejected
Canvas or chart payload can be repaired rather than resent. `propose_edit`
matches `oldText` exactly first, then retries ignoring CRLF and trailing
whitespace per line, and still requires the match to be unique. Enabling
`agentAutoApplyEdits` changes only who sends the proposal response; it does not
relax matching, vault path, read-back, or RunSQL target validation.

A `propose_edit` note proposal carries a preview windowed on the changed region, not
the note's leading characters: main aligns the two versions by line, keeps twelve
context lines around the changed span, and replaces each elided run with a marker
whose line count is identical on both sides so the renderer's line diff folds it as
unchanged. Without the window a change deep in a long note is invisible in the
approval card. On success the tool reports that the file re-read matches the bytes
written and states that content correctness is not checked; the older
"Wrote and verified" wording implied a semantic check that never happened. RunSQL
rewrite targets are keyed by the renderer-owned `rewriteTargetId` on the request's
message resources — never by `resource.id`, and never read off the deprecated
`attachments` field, which no production renderer path sets.

The Agent composer is a renderer-only ProseMirror document with one paragraph,
plain text, hard breaks, and atomic resource nodes. Each Agent tab retains its
own disposable EditorState so selection and undo history survive panel
unmounting and tab switches. A resource-catalog plugin holds the full typed
resource bodies; atom nodes contain only id, kind, and label. Sending or adding
a timeline entry serializes that state back to AgentMessageContent, so no
ProseMirror JSON or selection coordinate crosses IPC or enters Agent history.

External Add to Chat inserts at the saved selection head without deleting a
previous Composer range. Clipboard paste is intentionally plain text: copied
pills paste as their visible `@Kind · Label`, never as SQL/path-bearing live
resources ([ADR-0063](./adr/0063-prosemirror-agent-composer.md)).

Agent session files are native pi JSONL under
`{vault}/.stela/agent-history/<deviceSlug>/<sessionId>.jsonl`. Besides pi
session entries, Stela appends custom run entries that reconstruct the Agent
Panel timeline. A history summary identifies its owner device and whether it is
local; a remote session is read-only and a new prompt forks it to a local
`sessionId`.
`assistant_progress` is a bounded ordinary-text snapshot keyed by one-based
Harness `stepIndex`. Main sends throttled `streaming` snapshots directly to the
Renderer without Metrics or JSONL persistence, then appends exactly one
`completed` snapshot when that model step ends. Thinking blocks, tag-style
reasoning, and tool-call deltas are excluded. A new `final` event carries the
matching step index so the Renderer replaces that process entry with the final
answer; older final events without an index remain append-only compatible.
While a run is active, process entries stay in causal order around tool groups.
After settlement, prior process entries collect into one closed disclosure, and
strategy-review entries are also closed by default
([ADR-0074](./adr/0074-streamed-agent-process-narration.md)).
Each device retains only its 20 most recently updated session files; cleanup
never deletes another device's directory ([ADR-0047](./adr/0047-bounded-device-agent-history-retention.md)).

Agent `run_query` accepts an optional Vault `connectionName`; omission selects
the current note connection. The connector's `queryLanguages` and
`mongoOperations` determine whether SQL, structured MongoDB find, or safe
MongoDB aggregation is accepted. Aggregation uses a bounded stage allowlist and
rejects writes, cross-collection stages, facets, and server-side JavaScript. A
successful read returns at most 200 preview rows, 5 KiB total preview data, and
4 KiB per string cell to the model, while `rowCount` describes the full result.
A truncated result arrives under `sampleRows` instead of `rows`, so a partial
result is not presented as something countable; row- and byte-truncation reasons
stay explicit. History still records the wider host-enforced preview. When
possible the read also creates a machine-local artifact under Electron
`userData`, keyed by Vault hash, local `sessionId`, and query `runId`:

```typescript
type QueryArtifactFormat = "parquet" | "jsonl";
type QueryArtifactMode = "parquet-stream" | "jsonl-stream" | "jsonl-buffered";

interface QueryArtifactDescriptor {
  runId: string;
  sessionId: string;
  format: QueryArtifactFormat;
  mode: QueryArtifactMode;
  columns: ColumnDef[];
  rowCount: number;
  byteSize: number;
  createdAt: number;
  lastAccessedAt: number;
}
```

`execute_python({ sources?, code, reset? })` runs a cell in the current chat's
Vault/session-isolated workspace. Omitted sources reuse snapshots; redeclaring
an alias refreshes it without updating previously computed DataFrames. `reset`
clears state. Every cell clears the old `result` binding before execution. Queries
known before execution should be declared as sources and read by alias:

```python
orders = to_df('orders')       # pandas DataFrame
orders_rel = tables['orders']  # DuckDB relation
result = ...  # bounded scalar / DataFrame / DuckDB relation
```

Each source has a unique alias, optional connection name, and the same
structured SQL or MongoDB request as `run_query`. The Harness validates all
sources before running any of them, executes them read-only, and stages their
complete results without exposing run ids or artifact paths to the model. Up to
eight sources are accepted. A zero-row result without column metadata remains
available through `to_df(alias)` as an empty DataFrame. SQL and MongoDB sources
are discriminated contracts: SQL sampling limits must appear inside the SQL
statement, while the top-level `limit` field belongs only to MongoDB. Fields
from the other source kind are rejected before any query is executed.

A source is staged as a complete artifact, so an omitted MongoDB `limit` means
complete rather than `run_query`'s 200-row preview default; only `run_query`
keeps that default. A source that returns exactly as many rows as it asked for
is almost certainly cut off and nothing else in the response says so, because
the sandbox only sees the row count it was handed. `execute_python` therefore
returns an `incompleteSources` note naming each such alias and its limit, with
omitting `limit` or aggregating inside the source query as the two ways out.

`query(connection, request)` returns a DuckDB relation over the **full** result
(`.df()` for pandas) and remains the dynamic escape hatch when a request depends
on earlier Python computation. It is an authorized RPC back to main. `request`
is a SQL string or a MongoDB dict, validated by the same `normalizeDataQuery`
the `run_query` tool uses. Only a connection *name* crosses the sandbox boundary;
main resolves it, forces read-only via `classifySql(sql, false)` regardless of
`agentAllowMutations`, journals a `runId`, materializes an artifact, and streams
it in as bounded chunks under a host-generated alias. Artifacts stay the
transport, audit, and replay mechanism, but the model never names one. Per
execution, staged sources and dynamic calls share 32 queries and 2 GiB
materialized; a 60s inactivity timer refreshes on each completed query, with a
10-minute wall clock.

An app-owned Web Worker loads bundled Pyodide, DuckDB, pandas, NumPy, and their
pinned offline dependencies, runs code through `eval_code_async` so top-level
`await` works, and requires a bounded scalar/DataFrame/relation in `result`.
There is no Node API, host filesystem, subprocess, package installation, or
general network bridge. Only read-only `query()` and bounded semantic RPC are
injected JS capabilities. These end the sandbox's airtight JS isolation, so containment rests on
self-only CSP over a `file://` opaque origin, a Worker with no `window` or
preload, credentials never leaving main, main-side read-only enforcement, and
one journal entry per call. Timeout/cancellation terminates the Worker.
Artifacts are disposable, capped, TTL-cleaned, and never written to Vault
SQLite/JSONL, Markdown, Agent history, or Git. Headless evaluation implements
the same `query` protocol over the same Python program inside isolated Node
workers, without changing the desktop runtime or exposing a second model tool.
([ADR-0089](./adr/0089-session-python-workspaces.md),
[ADR-0068](./adr/0068-headless-pyodide-agent-evaluation.md))

`IPythonWorkspaceSnapshot` reports generation, ready/partial-mutation/lost status,
source versions/read times/incompleteness, refreshed aliases and bounded variable
types/shapes. It is runtime state, not proof of current database contents. Python
objects and inputs are memory-only and lost on application shutdown/Worker disposal.
Ordinary exceptions retain partial mutations; there is no transactional rollback.
Source aliases do not create Python variables: `tables['t']` is the relation and
`t_df = to_df('t')` explicitly creates a pandas snapshot. A missing name matching
a retained source gets alias-specific guidance, not a recommendation to reload.
`result` is a reserved output slot removed before **every** cell, regardless of
source refresh. Reusable intermediate values need other variable names. This is
not dependency invalidation. Explicit reset followed by NameError does not prove
unexpected Worker-loss handling; only `workspace_lost` establishes that path.

`semantic.classify`, `semantic.extract`, and `semantic.resolve` return a batch object
with `.rows` (stable positional id, status, value, evidence, error) and `.summary`
(coverage counts, cached results and cumulative per-run usage). Resolve additionally
returns `.mapping` with canonical IDs from actual input records. Candidate scopes
are explicit blocking fields, normalized with NFKC/case folding/whitespace, ranked
by token overlap and capped at 20 per record. Missing/truncated/contradictory
candidates remain unresolved; matching edges are not automatically transitive.
These helpers are discoverable through the `execute_python` description and the
bundled `load_skill(name='semantic-analysis')` instructions, not separate tools.
Synthetic DataFrames need no database connection. See the
[Chinese acceptance checklist](./testing/semantic-workspace-acceptance.md) for
offline service integration coverage and the separate desktop UI checks.

The typed host broker accepts at most eight records per request, validates a
documented JSON-schema subset, and checks evidence against original selected fields.
Selected data is redacted using the existing secret filter and treated as untrusted
data, not instructions. Schema/evidence validation does not establish semantic truth.
Each row receives at most two extra attempts. Shared run defaults are 1000 records
or pairs, 200 requests and 200000 tokens; token reservations use conservative UTF-8
input estimates and bounded output, reconciled with provider usage when available.
No dollar estimate is fabricated. The app-wide inference concurrency limit is four.

Semantic operation additions ([ADR-0091](./adr/0091-semantic-operation-completeness.md)):

- `phase=preflight`, `totalRecords` and up to eight probe records inspect cache/capacity
  through the existing authorized broker, without provider inference. `control` carries
  remaining budget, `canStartFull`, bounded/complete cache coverage, conservative
  required-record upper bound, minimum requests, ledger revision and opaque model identity.
  Preflight is not a reservation; subsequent execution always enforces the shared budget.
- Python defaults to full intent; `allow_partial=True` is explicit partial work, not sampling.
  Exhaustion drains in-flight batches then synthesizes remaining unprocessed rows locally.
- `required_fields` must be selected and are validated again by the host. This does not
  infer natural-language dependencies. classify/extract optionally accept unique `id_column`.
- `.rows` remains a DataFrame; `.to_records()` returns dictionaries. `.summary.complete`
  and `.require_complete()` expose unresolved/failed/unprocessed coverage explicitly.
  `.summary.reused` counts retained rows, separately from cache hits and run usage.
- `resume=previous_batch` requires identical full input/order/definition and host model
  identity. A private copied row snapshot preserves successful/unresolved rows even if
  the displayed DataFrame is edited. Only failed/unprocessed rows are retried. A model
  switch requires an explicit new operation. Workspace reset/loss destroys this state.

Generation lifecycle ([ADR-0095](./adr/0095-generation-lifecycle-and-safe-closeout.md))
separates caller cancellation, opt-in response/first-delta/idle/total deadlines, and
a retry window starting at the first transient failure. `IGenerationDiagnostic`
retains delta timing/counts/bytes and complete/partial/unknown usage, never extra
thinking text. Normal generation has no fixed three-minute ceiling. Shared evidence
closeout makes at most one tool-free request, only after eligible failure with
committed query/Python evidence and remaining time. `AgentEvent.error.partialAnswer`
is optional: it displays recoverable evidence without converting error to completed.
Legacy errors remain compatible. DAB preserves executionFailure, closeout status
and generationUsage uncertainty separately from evaluator validity.

`analysis.contract(required=[...])` is local evidence bookkeeping, available without
semantic transmission ([ADR-0093](./adr/0093-evidence-backed-answer-contract.md)).
Supported fields: population/metric/granularity/denominator/business_rule/time_range.
`claim(field,value,source=...,evidence=...)` rejects missing evidence or silent conflicts.
`check_equal`, `check_granularity` and `check_coverage` verify supplied observations;
`report()` exposes unresolved claims/failed checks and `structurallyReady`.
`require_ready()` rejects missing or failed evidence but is not an Agent final-answer
gate. Model-authored claims and completeness of a filtered input are not certified.
Recipes are in the bundled `analysis-verification` Skill; skip trivial tasks.

Default-off `AiSettings.semanticOptimizationEnabled` and
`automaticAnalysisContractsEnabled` select the experiments in ADR-0097/0098.
`IAnalysisExecutionContext` carries trusted run ID, original question and flags on
`PythonExecutionRequest`. The shared strict `analysisSnapshotSchema` bounds optional
`PythonExecutionResult.analysis`: version/generation/status, model claims/checks and
source-resolution flags, source row counts, full/subset/unknown coverage, previous
version count and truncation. Source refresh, cell failure and unknown lineage
cannot certify current coverage. `analysis.current` is lazy; explicit contracts are
registered as revisions. `bind_population(df, id_column=..., source=..., source_id_column=None)` freezes
source-verified typed IDs and per-cell fingerprints; it cannot be silently rebound to a smaller cohort.
Snapshots are automatically captured and preserved through existing tool history.
`contract.observe(batch)` (ADR-0099) verifies an existing operation via a weak
run-local registry, independent of mutable public result rows/summary. Records retain
at most 100,000 rows / 1,000,000 cells of fingerprints, not text copies. Operation
counts (`operationCoverage`) are separate from bound-population `coverage`; its
optional `reason` explains unknown/partial status. Epoch invalidation survives later
successful cells; host-side failures propagate using optional trusted
`IAnalysisExecutionContext.invalidateEvidence`. Source versions must still match.
No implicit ID normalization, batch union or business certification is added.
Legacy explicit contract behavior remains when the experiment is off.

Optimized classify/extract returns all original IDs after exact selected-content
reuse. Preflight checks every unique cache key and exposes scale, packed request
counts and conservative reservations. The `pilot` semantic phase requires host
experiment enablement and an operation signature; one attempt and a 10% reservation
cap share the existing run ledger. Model/definition/full-input identity constrain
reuse, and forecasts never authorize sampling or guarantee completion. Resolve
and the selected inference profile are unchanged. See
[experiment protocol and API example](./testing/analysis-experiments.md).

`AiSettings.semanticProfileId` defaults to the current run profile;
`semanticBudget` supplies configurable limits. Grants are local under application
userData, keyed by Vault and endpoint/vendor/model, never in Vault settings or Git.
First transmission and budget increases require explicit confirmation. Revocation
aborts active semantic calls. `semantic_progress` exposes counts and usage; child
inference tokens are charged to the parent Agent run. See [ADR-0090](./adr/0090-bounded-semantic-execution.md).

`search_sql_usage({ table })` finds a table in either read or write position;
the Agent uses it when established joins, filters, write direction, or business
conventions matter, not merely because a table name is known. `readTable` and
`writeTable` remain available when the caller needs only one direction.

Safety ([ADR-0067](./adr/0067-safe-mongodb-aggregation-queries.md)):

- `sql-guard` classifies read-only vs mutation vs multi-statement
- Mutations, questions, and `propose_edit` resolve through `ai:agent-respond-proposal`. Mutations/questions are always manual; note and RunSQL edits may receive an automatic response only when `agentAutoApplyEdits` is enabled ([ADR-0088](./adr/0088-configurable-automatic-agent-edits.md))
- Runs continue until model completion, error, or explicit user cancellation ([ADR-0017](./adr/0017-user-cancelled-agent-runs.md))
- Read tools and `run_query` may execute in parallel. `execute_python`, plan mutations, chart creation, Canvas creation/update, and `propose_edit` are sequential ([ADR-0021](./adr/0021-parallel-agent-tools-except-propose-edit.md), [ADR-0086](./adr/0086-declarative-query-sources-for-python.md)). NodeExecutionEnv is harness cwd only (not exposed as model tools)
- Compaction uses `ai.contextWindow` + one overflow recovery ([ADR-0018](./adr/0018-pi-ai-agent-harness.md))
- Execution plans are bounded and linear. Their active store is main-process runtime state; every versioned `AgentPlanSnapshot` is appended immutably to the pi session, and only the highest version for the current run is active ([ADR-0060](./adr/0060-cache-stable-agent-prompts.md), [ADR-0046](./adr/0046-device-sharded-agent-session-history.md))
- A plan grants no authority over the answer and never gates it. The sequential `plan` tool uses `action=create|update|get`; create/update report a note — unknown step id, out-of-order completion, overwritten terminal step — instead of failing the run, evidence lines are optional, and get is for recovery only. Old plan names remain internal trace aliases but are absent from the provider schema. Answer correctness is defended at the point of use: a truncated `run_query` result returns only `sampleRows` plus an instruction that they cannot support an exact result, each sandbox `query()` prints its relation's row/column count and column types, and the stable prompt fixes the answer shape. Successful query/Python calls still register disposable same-run evidence metadata for chart and Canvas binding, and Python evidence retains its source run lineage; Stela does not pre-scan sources or persist an evidence catalog ([ADR-0084](./adr/0084-single-action-plan-tool.md))
- The Agent system prompt and tool list are request-invariant. The compact stable prompt contains only Stela-wide trust, grounding, approval, locale, rendering, and final-answer contracts. Operation-specific guidance belongs in the relevant tool description or a deterministically named System Skill. Dynamic context, including explicit availability states and deterministic current-run guidance for Canvas, RunSQL rewrite, Vault Skills, and MongoDB, is bounded, redacted, and appended in the user turn immediately before the request; pi-ai uses short cache retention and session affinity ([ADR-0060](./adr/0060-cache-stable-agent-prompts.md), [ADR-0083](./adr/0083-sourced-system-skills.md))
- RunSQL fix/schema quick actions auto-submit in a new Agent tab; rewrite/question actions open editable drafts. `runsql_rewrite` proposals are bound to the original SQL snapshot and renderer target, then reuse the inline diff accept/discard UI. Automatic edit mode keeps those target checks and applies through the same proposal response path ([ADR-0088](./adr/0088-configurable-automatic-agent-edits.md))
- Note and Canvas references are paths only; the Agent reads them only when the task relies on their contents
- Selection / RunSQL attachments are bounded current-turn evidence. Surrounding notes or live schema are retrieved only when missing context could materially change the answer
- `ask_user` blocks on the same handshake with `kind: "question"`, resolving to the answer string; ≤3 questions per run, enforced in the tool ([ADR-0027](./adr/0027-agent-ask-user-clarification.md))
- Final answers are complexity-aware and concise: simple facts lead with the answer in 1–3 sentences, while analytical questions include only the findings needed in priority order. Query-backed answers end with one compact data-basis line (table · fields · calculation); assumptions or uncertainty appear only when material ([ADR-0039](./adr/0039-concise-agent-final-answers.md))

### Agent Skills

Agent Skills have an explicit runtime `origin`: `system` or `vault`. Both are
loaded with pi-agent-core's `loadSourcedSkills` and read through the existing
`load_skill(name)` tool. A successful load returns its `source`; only a System
result is trusted as Stela-provided task guidance. Live schema, successful query
results, validators, and the user's goal remain authoritative over any Skill.

A System Skill is a read-only application method shipped below
`resources/playbooks/<skill-name>/SKILL.md`. It is always fresh, has no Vault
category/tags/provenance contract, and is absent from automatic prompt ranking,
`search_skills`, maintenance, and Experience Knowledge. Capability descriptions
must name it exactly at the point of use. System names are reserved against Vault
save/archive and same-name Vault files are rejected at load
([ADR-0083](./adr/0083-sourced-system-skills.md)).

A Vault Skill is internal, user-maintained data knowledge in `SKILL.md` below
`{vault}/.stela/skills/<skill-name>/`. Its YAML frontmatter must include a
non-empty `description`, a `category` from `sql-dialect`, `metric-definition`,
`business-glossary`, `data-lineage`, or `analysis-runbook`, and a non-empty inline
`tags` list; `name` defaults to the parent directory name. Loading applies the
same validation as writes. Routine lexical ranking selects at most eight fresh
positive matches for the bounded context envelope; `knowledge-maintenance` turns
receive no automatic Skill candidates.

Its body is a bounded reusable knowledge unit governed by a category template:
dialect uses Scope/Rule/Valid Pattern/Verify, metrics use
Scope/Definition/Grain & Filters/Verify, glossary uses
Scope/Term Mapping/Rule/Verify, and lineage uses
Scope/Source → Transform → Target/Keys & Grain/Verify. Analysis runbooks require
an explicit user request plus trigger, ordered checks, a decision branch, stop
conditions, and verification. A Skill is at most 6,000 characters; its description is
at most 160 characters; its body has at most 80 lines and two code examples of at
most 20 lines each. Analysis narration, result rows, and one-off SQL belong to run
history or Vault notes instead.

The model calls `search_skills(query)` for ranked Vault metadata or omits `query` to
browse active Vault metadata in stable name-ordered pages. Search pages default to eight
and cap at 20; browse pages default to 20 and cap at 50. Both return `nextOffset`
and a freshness state. Routine calls omit stale page rows; explicit knowledge
maintenance includes them for repair. Browsing does not mark every returned item
as a usage candidate.
Automatically maintained files may add single-line flow-style `sources` metadata
with at most three `{path, sha256}` records and `source_tables` with at most eight
qualified table anchors. Paths are Vault-relative and server-injected only from
notes actually retrieved for the maintenance job. Explicit maintenance supplies
per-Skill `sourcePaths` and `sourceTables`; runtime accepts only a subset of notes
read and tables inspected in its current turn. `fresh` means tracked
sources still match, `stale` means a tracked source changed, disappeared, or was
superseded by the current SQL-usage note set, and `untracked` means no source hash
exists. Routine `load_skill` rejects stale content with `stale_skill_unavailable`,
queues a background refresh, and warns on untracked content. Explicit maintenance
may read stale or untracked bodies only as untrusted drafts and must verify their
rules before saving.

After a normal completion with successful tool evidence, an independent bounded
maintenance job receives the complete current-task conversation, structured
evidence, at most three ordered source documents, and related Skill metadata. All
retrieval is deterministic; the maintenance harness exposes only `save_skill` and
may create one templated Skill or no-op. It cannot overwrite or archive existing
Skills, call SQL, search the Vault broadly, or edit notes. Automatic creation
rejects `analysis-runbook`; those require an explicit normal Agent request. The normal Agent can also call
`save_skill` when the user explicitly asks to retain verified reusable data
knowledge. A `skill_maintenance` event contains only concise action metadata for a
small status indicator inside the final-answer bubble, never a Skill body. An
explicit write supplies that final-answer status directly and skips the redundant
automatic maintenance turn. The bottom-bar Experience Knowledge entry opens an
application-level dialog using `agent.listSkills()` to show metadata (name,
description, category, tags, relative path, and active/archived status). After
confirmation, `agent.removeSkill(relativePath)` may move only that listed Skill
directory to the system trash; it cannot read bodies or mutate other Vault paths.
Skill bodies have no renderer edit or slash-command contract; Settings exposes
only the automatic-maintenance policy toggle.

An empty Agent conversation renders centered, low-emphasis executable text actions
instead of prompt examples. Note and Canvas actions bind the active artifact as a
message resource and call the existing Agent start path immediately. The explicit
`knowledge-maintenance` entry point receives no bulk Skill metadata in its message;
it starts by omitting `query` from `search_skills`, follows `nextOffset`, and uses
targeted searches only after a broad inventory. It loads only selected candidate
bodies, permits at most three evidence-backed Skill changes, and forbids note edits.
No active document means only this Vault-level action is shown; a click reuses the
current empty conversation ([ADR-0073](./adr/0073-three-state-skill-freshness.md)).

### Agent observability

`AgentEvent.skill_maintenance` adds optional `outcome` and `diagnostic` fields
([ADR-0096](./adr/0096-explicit-knowledge-maintenance-outcomes.md)). Outcomes separate
saved/no-change from safe skips, cancellation, timeout/turn-limit, dropped work,
and errors. Diagnostics contain a bounded redacted message, stage, and metric run
ID. Legacy events remain readable; no outcome plus no actions means unknown, not
success. Saved actions do not override an explicit failure. Background terminal
events are persisted to the existing conversation history after the answer.

Agent observability is local and Vault-scoped but not Git-synced. A metric run
has a `surface` (`agent`, `tool`, `skill_maintenance`, `ai_action`, or
`sql_query_parse`), operation, terminal status, optional
surface-specific outcome, duration, first-result latency, provider/model,
token usage, error metadata, and optional parent run. Ordered metric events
carry the redacted trace. Tool and maintenance runs use their Agent run as
`parentRunId`.

`AgentMetricSessionTrace` is a read-only projection, not a third storage
authority. It contains the authoritative `AgentHistorySession`, one-based user
Turns in history order, and an optional `AgentMetricRunTree` for every history
run. A run tree contains the root Agent trace and every descendant tool or
maintenance trace. The tree is `null` when local Metrics have expired or been
cleared. Harness model context, provider requests, first-token arrival,
assistant completion, and step completion use a shared `step:<index>` event
name. The renderer projects these records into action nodes rather than a raw
event list: model, tool, approval, strategy review, and compaction form the main
trajectory, while Skill maintenance is post-answer work. User/system/business
context, `context_usage`, token counters, plan/Canvas side effects, and
lifecycle records are details of those actions or Turn-level diagnostics.

`model_context` is a local metric event containing the provider-neutral message
list, model identity, requested and effective reasoning effort, and configured
context-window capacity. The legacy-compatible `thinkingLevel` field mirrors
the effective effort. It is captured by the Harness `context` hook; `provider_payload` is
captured by the `before_provider_payload` hook. Neither event is a public
`AgentEvent` or a new
IPC contract. Unknown metric events remain readable as diagnostics and never
become execution nodes implicitly.

Model detail separates visible output, current-call reasoning, compact model
input, and bounded Raw data. Historical thinking and tool arguments stay
collapsed in model input; tool request names may be summarized in model output,
while full arguments and results remain on the causal tool node. Reasoning
content is optional even when reasoning effort or reasoning-token usage is
reported.

Dashboard token usage exposes `promptTokens = inputTokens + cacheReadTokens +
cacheWriteTokens` and `cacheHitRate = cacheReadTokens / promptTokens`. The rate
uses provider-reported counters, excludes output tokens, and is `null` when no
prompt usage was reported. Surface breakdowns expose the same derived rate, and
individual traces retain their raw token counters. Model context-window
occupancy is `promptTokens / contextWindow`, not total tokens, so the current
step's output and reasoning are not counted as input context.

The renderer can only call `agentMetrics.getDashboard`, `listRuns`, `getTrace`,
`getSessionTrace`, and `clear`. `getSessionTrace` accepts an `AgentHistoryRef`;
the main process loads that history and joins it to the already-open local
Metrics store by `agent:<runId>`. Date ranges are exactly `7d`, `30d`, or `90d`; trace queries are
cursor-paginated, bounded to 100 records by IPC, and displayed ten at a time.
Inline completion does not enter this store; schema version 2 removes legacy
inline runs and their events. Cancellations are reported separately from
provider errors. Knowledge maintenance reports saved, no-change, no-source,
input-too-large, dropped, timeout, error, and disabled outcomes rather than a
generic success rate. Root user-facing runs alone feed the overview reliability
and daily activity totals; child maintenance and tool runs stay in their own
breakdowns. Prompt-ranked and `search_skills` results create per-run Skill
candidate events; a successful `load_skill` creates a usage event. Candidate and
used counts are deduplicated by Agent run and Skill, while load count preserves
repeated calls. Saved maintenance actions carry their validated Skill category
so the dashboard can report generated-category counts and shares. A no-source
run contains a structured response explaining why no verified Vault Markdown
source matched; it exits before invoking the maintenance model
([ADR-0052](./adr/0052-signal-focused-agent-observability.md)).
`AgentMetricsDashboard.latestKnowledgeMaintenanceAt` is the most recent retained
manual `knowledge-maintenance` run or background maintenance attempt, excluding
disabled and dropped jobs. It is `null` after Metrics are cleared or when the
90-day local retention window contains no such run.

Retrieval results ([ADR-0026](./adr/0026-ranked-lexical-retrieval-for-agent.md)):

```typescript
interface NoteSearchHit {
  path: string;
  title: string;
  score: number;
  matchCount: number;
  matchedKeywords: string[];
  matchedHeadings: string[];
  bestSnippet: string;
  bestLine: number;
}

interface NoteSearchResult {
  notes: NoteSearchHit[];
  scannedNotes: number;
  totalMatchedNotes: number;
  returned: number;
  truncated: boolean;
}
```

`search_vault` returns this note-level shape (full scan, then rank, then truncate); the line-level `SearchHit` from `searchVault` stays with the UI search panel. `search_tables` candidates additionally carry `vaultUsage` (notes, blocks, last run date), which the model reads but which never enters the score.

### UI entry points

| Surface | Location | Backend |
|---------|----------|---------|
| RunSQL fix / rewrite / ask | `codeblock-nodeview` → new Agent tab; rewrite returns to the block diff | `ai:agent-run` + `runsql_rewrite` proposal |
| Schema explanation | `SchemaBrowserPanel` → new Agent tab | `ai:agent-run` + events |
| Agent chat | `AgentSidebar` / `agent-panel` | `ai:agent-run` + events |
| Analysis Canvas | `AnalysisCanvasView` | `canvas:read` / `canvas:update-flow-layout`; refresh uses `ai:agent-run` with typed Canvas scope |
| Inline resources | Agent composer `@` picker / add-resource button | ordered `message.segments` + deduplicated `message.resources` |
| Current Workspace tab | active note / Canvas at send time | implicit `workspaceContext` on `ai:agent-run`; no composer/timeline pill |
| Add to Chat | editor context menu / `Mod+I` | inserts a RunSQL/selection resource at the saved composer caret |
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

## Export bridge

`window.stela.export.saveMarkdown()` and `saveFile()` open a native save dialog in main and return the chosen path plus an ephemeral `revealToken`. The renderer may pass that token only to `revealSavedFile()` to select the just-saved file in Finder, Explorer, or the platform file manager. The token is process-local and avoids extending the vault-only shell bridge to arbitrary filesystem paths.

## Renderer State Stores

Zustand stores in `src/state/`:

| Store | File | Holds |
|-------|------|-------|
| Workspace | `workspace.ts` | Open Markdown/source/Canvas tabs, active file, vault path |
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
vault-watcher (@parcel/watcher, main)
    │ vault:external-change { paths, kind }
    ▼
renderer subscriber (vault-watcher-subscriber.ts)
    ├── clean tab → reload file content
    ├── dirty tab → conflict prompt (no silent overwrite)
    ├── vault-index / sql-index incremental rebuild
    └── AutoGit schedule → 3s quiet period → git.syncNow

focus / online ────────────────────────────────┐
60s fallback sync scan ───────────────────────┴─→ immediate git.syncNow
```

The watcher includes a narrow Git-shared `.stela` allowlist: settings,
connections, execution history, Agent history, Skills, and SQL templates. It is
an event source, not a storage authority; missing watcher events affect latency
only because the fallback scan still evaluates Git state.

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
