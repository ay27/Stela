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
  chart?: StelaEmbeddedChartSpec | null;
  chartError?: string;   // runtime-only validation state
}
```

Serialization preserves `detailRaw` verbatim during ordinary editing. A pending
detail may contain only `<block-id>` and `<chart>`; successful execution rewrites
the execution fields while preserving the chart. The embedded chart's block id
must equal `DetailMeta.blockId`.

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

### StelaChartSpec

Analytical charts are versioned JSON owned by `DetailMeta.chart`. The shared Zod
schema in `electron/shared/chart-spec.ts` is the single parser for Agent output,
RunSQL rendering, and export. The initial discriminated chart set is
`kpi | bar | line | pie | funnel | histogram`; each type names result columns
instead of containing rows or executable expressions.

`source.kind = "run"` pins a conversation chart to one audited execution.
`source.kind = "block"` strongly associates a persisted chart with its enclosing
RunSQL block. The current or selected historical `<result-ref-id>` supplies data;
missing cache data may be restored by exact run id from the JSONL journal.

The validator rejects unknown properties, missing/non-numeric fields, empty
results, more than 5,000 rows, and type-specific category limits. Aggregation and
business calculations belong in SQL; charts do not silently sample results.

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

interface AiProviderProfile {
  id: string;
  name: string;
  vendorId: string;                // pi-ai provider id, or "custom"
  model: string;
  baseUrl: string;                 // required for custom; unused for builtins
  contextWindow: 64_000 | 128_000 | 200_000 | 256_000 | 1_000_000;
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
  sendResultSamples: boolean;
  maxSampleRows: number;
  agentMaxIterations: number;      // legacy; ignored by harness agent
  agentWallClockMs: number;        // legacy; ignored by harness agent
  agentAllowMutations: boolean;    // still requires per-call user approve
}
```

API key shard: `{vault}/.stela/secrets/ai_{deviceSlug}_{profileId}.json` (safeStorage-wrapped). Transport: pi-ai built-in provider for `vendorId`, or `createProvider` for `custom` ([ADR-0022](./adr/0022-ai-multi-provider-profiles.md)); agent loop: `AgentHarness` ([ADR-0018](./adr/0018-pi-ai-agent-harness.md)). Inline completion is enabled only when `completionProfileId` names an existing profile.

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

Pipeline: enrich schema → cap sizes → optional samples → `redactForPrompt` → action prompt → pi-ai `completeSimple`. See [ADR-0014](./adr/0014-ai-context-redaction-and-schema-enrichment.md).

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

IPC uses `AI_INLINE_COMPLETION_START`, `AI_INLINE_COMPLETION_CANCEL`, and push event `ai:inline-completion-event`; preload exposes `window.stela.ai.startInlineCompletion`, `cancelInlineCompletion`, and `onInlineCompletionEvent`. Completion uses `completionProfileId` independently of chat/agent `activeProfileId` and simulates FIM over pi-ai `streamSimple`.

Schema context comes from two sources ([ADR-0028](./adr/0028-inline-completion-schema-and-note-context.md)): `tableSchemas` carries columns the renderer already holds in `column-cache` for tables in the cursor's FROM/JOIN scope, and main adds DDL for referenced tables found in the connection's local `schemaDir`. Per table, renderer columns win; a table with a DDL snippet contributes only that snippet to the prompt, and a cache-only table contributes its column list. The request never triggers a column probe — probes are warmed when a RunSQL block gains focus. Missing snapshots never fall back to connector list/execute calls.

Other RunSQL blocks in the same note are sent as bounded reference context, ordered by document distance from the current block and capped at 8K characters; `heading` and `prose` add the surrounding section's intent. RunSQL starts only after an edit has been idle for 120 ms at a line tail, rejects stale `requestId`/cursor context, and displays at most one ghost-text line. Focus, click, selection movement, and settings changes do not start requests. A native completion popup takes priority; after it closes, a pending edited context is scheduled again. Before display and Tab acceptance, deterministic normalization removes repeated text and suffix overlap, and restores a missing leading space at an identifier boundary. Replacement, Escape, blur, composition start, popup opening, or destroy cancels active requests. Tab accepts visible ghost text; accept and dismiss write a dev-only log line.

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

Agent schema tools have one authority: the current live connector. `search_tables`
enumerates its catalog and `get_table_schema` fetches current DDL or columns;
they do not read the optional connection `schemaDir` dump ([ADR-0041](./adr/0041-agent-live-schema-authority.md)).

When the connector implements `describeTables(kind, config, tables)` the schema
resolver calls it once per lookup and uses the returned `TableDescriptor`
columns (with `comment`) directly. Otherwise it falls back to `SHOW CREATE TABLE`
→ `DESCRIBE` → `SELECT ... LIMIT 0` ladder; old plugins keep working
([ADR-0042](./adr/0042-connector-describe-tables-api.md)).

```typescript
type AgentToolName =
  | "list_databases" | "list_tables" | "search_tables" | "get_table_schema"
  | "run_sql" | "search_sql_usage"
  | "search_vault" | "list_vault_files" | "read_note"
  | "create_plan" | "update_plan" | "get_plan"
  | "search_skills" | "load_skill" | "save_skill" | "propose_edit" | "ask_user";

type AgentProposalKind = "edit_note" | "mutation_sql" | "question";

interface AgentProposalPayload {
  description: string;
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

interface AgentPlanSnapshot {
  runId: string;
  version: number;
  steps: AgentPlanStep[];
}

type AgentEvent =
  | { type: "started"; runId: string }
  | { type: "plan_updated"; runId: string; plan: AgentPlanSnapshot }
  | { type: "tool_call"; runId: string; call: AgentToolCallInfo }
  | { type: "tool_result"; runId: string; callId: string; ok: boolean; summary: string }
  | { type: "proposal"; runId: string; callId: string; kind: AgentProposalKind; payload: AgentProposalPayload }
  | { type: "context_usage"; runId: string; usedTokens: number; contextWindow: number; estimated: boolean }
  | { type: "compaction"; runId: string; phase: "started" | "completed" }
  | { type: "history_updated"; runId: string }
  | { type: "final"; runId: string; content: string }
  | { type: "error"; runId: string; message: string }
  | { type: "cancelled"; runId: string };
```

Agent session files are native pi JSONL under
`{vault}/.stela/agent-history/<deviceSlug>/<sessionId>.jsonl`. Besides pi
session entries, Stela appends custom run entries that reconstruct the Agent
Panel timeline. A history summary identifies its owner device and whether it is
local; a remote session is read-only and a new prompt forks it to a local
`sessionId`.
Each device retains only its 20 most recently updated session files; cleanup
never deletes another device's directory ([ADR-0047](./adr/0047-bounded-device-agent-history-retention.md)).

`search_sql_usage({ table })` finds a table in either read or write position.
`readTable` and `writeTable` remain available when the caller needs only one
direction.

Safety ([ADR-0013](./adr/0013-agent-tools-sql-guard-and-proposals.md)):

- `sql-guard` classifies read-only vs mutation vs multi-statement
- Mutations + `propose_edit` block on `ai:agent-respond-proposal`
- Runs continue until model completion, error, or explicit user cancellation ([ADR-0017](./adr/0017-user-cancelled-agent-runs.md))
- Tools use `executionMode: "parallel"` except `propose_edit` (`"sequential"`) ([ADR-0021](./adr/0021-parallel-agent-tools-except-propose-edit.md)). NodeExecutionEnv is harness cwd only (not exposed as model tools)
- Compaction uses `ai.contextWindow` + one overflow recovery ([ADR-0018](./adr/0018-pi-ai-agent-harness.md))
- Execution plans are bounded and linear. Their active store is main-process runtime state, while the latest `AgentPlanSnapshot` is appended to the persisted pi session so its context projector can recover after restart ([ADR-0038](./adr/0038-runtime-agent-execution-plans.md), [ADR-0046](./adr/0046-device-sharded-agent-session-history.md))
- Note references are paths only; the agent should call `read_note` before relying on note contents
- Selection / RunSQL attachments are bounded and included only on the user turn that added them
- `ask_user` blocks on the same handshake with `kind: "question"`, resolving to the answer string; ≤3 questions per run, enforced in the tool ([ADR-0027](./adr/0027-agent-ask-user-clarification.md))
- Final answers are concise: direct answer + key numbers in 1–3 sentences, one compact evidence line (table · column · SQL logic); assumptions / uncertainty sections only when an ambiguity was actually resolved or remains open ([ADR-0039](./adr/0039-concise-agent-final-answers.md))

### Agent Skills

An Agent Skill is an internal, Vault-maintained pi-compatible `SKILL.md` below
`{vault}/.stela/skills/<skill-name>/`. Its YAML frontmatter must include a
non-empty `description`, a `category` from `sql-dialect`, `metric-definition`,
`business-glossary`, `data-lineage`, or `analysis-runbook`, and a non-empty inline
`tags` list; `name` defaults to the parent directory name. Loading applies the
same validation as writes and local lexical ranking selects at most eight
positive-match metadata records for the main system prompt.

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

The model calls `search_skills(query)` for further metadata and
`load_skill(name)` to add a matching Markdown body to the current tool loop.
Automatically maintained files may add single-line flow-style `sources` metadata
with at most three `{path, sha256}` records and `source_tables` with at most eight
qualified table anchors. Paths are Vault-relative and server-injected only from
notes actually retrieved for the maintenance job. Before loading, Stela compares
source hashes and the current newest SQL-usage note set; stale knowledge must be
refreshed successfully or is withheld from the Agent.

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

### Agent observability

Agent observability is local and Vault-scoped but not Git-synced. A metric run
has a `surface` (`agent`, `tool`, `skill_maintenance`, `ai_action`, or
`sql_query_parse`), operation, terminal status, optional
surface-specific outcome, duration, first-result latency, provider/model,
token usage, error metadata, and optional parent run. Ordered metric events
carry the redacted trace. Tool and maintenance runs use their Agent run as
`parentRunId`.

The renderer can only call `agentMetrics.getDashboard`, `listRuns`, `getTrace`,
and `clear`. Date ranges are exactly `7d`, `30d`, or `90d`; trace queries are
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

## Export bridge

`window.stela.export.saveMarkdown()` and `saveFile()` open a native save dialog in main and return the chosen path plus an ephemeral `revealToken`. The renderer may pass that token only to `revealSavedFile()` to select the just-saved file in Finder, Explorer, or the platform file manager. The token is process-local and avoids extending the vault-only shell bridge to arbitrary filesystem paths.

`window.stela.export.saveMarkdownBundle()` accepts a Markdown template plus a
bounded list of identified SVG strings. After the user chooses the destination,
Main derives `<markdown-stem>.assets/`, creates unique files, replaces only
`stela-asset://<id>` placeholders with relative Markdown paths, and writes the
Markdown last. Asset ids, counts, extensions, and byte sizes are Zod validated;
the renderer never receives a general-purpose arbitrary-path write API.

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
vault-watcher (@parcel/watcher, main)
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
