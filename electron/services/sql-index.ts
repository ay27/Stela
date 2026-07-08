/**
 * SQL 事实索引（main 进程，纯内存）。
 *
 * 对齐 plan「SQL AST 索引与结构化检索」Part C：vault 打开时后台异步全量构建，
 * fs 变更走 vault-watcher 增量更新，vault 切换 / app 退出时销毁（v1 不落盘）。
 *
 * 构建流程：walk `.md` → `parseRunsqlFences` 切出每个 runsql 块（含跟随的
 * `<detail>`）→ 读笔记 frontmatter 的 `connection_name` → 连接 kind → dialect
 * → `extractSqlFacts` 抽事实 → 写正排（`docs[docId]`）+ 倒排（`Map<term, docId[]>`）。
 *
 * 内存布局（对齐 plan「内存友好的数据布局」）：
 *   - **整型 docId**：`docs: (BlockDoc | null)[]` 平铺数组，下标即 docId。
 *   - **不存 SQL 全文**：正排只存 `codeStart/codeEnd` 字符偏移，`query()` 时按
 *     path 懒读文件切片出 snippet（对齐 `search.ts` 的懒读做法）。
 *   - **字符串驻留**：表名 / 列名 / 连接名 / 方言名 / 文件路径都进 `Interner`，
 *     正排 / 倒排里只存 int id。
 *   - **倒排排序整型数组**：`Map<term, number[]>`，term 只有"操作类型 × 表 × 列
 *     × 连接"几个维度的笛卡尔组合，基数很小（几百到几千），value 数组才是主要
 *     内存开销——用有序整型数组代替 `Set<string>`。
 *   - docId 单调递增、从不复用：增量更新时旧文档"墓碑化"（`docs[id] = null`），
 *     新文档 append 在数组末尾，天然维持 posting 数组的有序性，避免删除时要
 *     重排所有受影响 posting。
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import type {
  ConnectionMap,
  ConnectorKindMeta,
  SqlIndexFacets,
  SqlIndexFilter,
  SqlIndexHit,
  SqlIndexOperation,
  SqlIndexStatus,
} from "@shared/types";
import { IPC_EVENTS } from "@shared/ipc-events";
import { parseFrontmatterField, splitFrontmatter } from "@shared/frontmatter";
import { parseRunsqlFences } from "@shared/runsql-fences";
import { extractSqlFacts, type StatementFacts, type TableRef } from "@shared/sql-facts";
import { lezerDialectFor, resolveDialect } from "@shared/sql-dialect";

import { getLogger } from "./logger";
import * as connectionsStore from "./connections-store";
import * as connectorRegistry from "./connectors/registry";
import * as deviceProfile from "./device-profile";
import * as vaultWatcher from "./vault-watcher";

const log = getLogger("sql-index");

const STELA_EXTS = new Set([".md"]);
/** 单文件大小上限，与 vault-index.ts 一致——离群大文件跳过解析 */
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const BROADCAST_DEBOUNCE_MS = 250;
const DEFAULT_MAX_HITS = 200;
const SNIPPET_MAX_CHARS = 400;

// ---------- 字符串驻留 ----------

class Interner {
  private readonly toId = new Map<string, number>();
  private readonly toStr: string[] = [];

  intern(s: string): number {
    const existing = this.toId.get(s);
    if (existing !== undefined) return existing;
    const id = this.toStr.length;
    this.toStr.push(s);
    this.toId.set(s, id);
    return id;
  }

  lookup(s: string): number | null {
    return this.toId.get(s) ?? null;
  }

  get(id: number): string {
    return this.toStr[id]!;
  }

  values(): string[] {
    return [...this.toStr];
  }

  clear(): void {
    this.toId.clear();
    this.toStr.length = 0;
  }
}

// ---------- 正排 ----------

interface StoredColumnRef {
  /** 裸表名 id；null 表示无法归属到具体表（多表 UPDATE 未加前缀的列等） */
  tableId: number | null;
  columnId: number;
}

interface StoredStatement {
  operation: SqlIndexOperation;
  /** 裸表名 id（去重） */
  readTableIds: number[];
  writeTableIds: number[];
  writeColumns: StoredColumnRef[];
}

interface BlockDoc {
  fileId: number;
  blockIndex: number;
  /** 1-based，fence 起始行 */
  line: number;
  codeStart: number;
  codeEnd: number;
  blockId: string | null;
  connId: number | null;
  dialectId: number | null;
  runDate: string | null;
  statements: StoredStatement[];
}

interface Runtime {
  vaultPath: string;
  slug: string;
  tables: Interner;
  columns: Interner;
  connections: Interner;
  dialects: Interner;
  files: Interner;
  /** docId = 下标；tombstone 后置 null，位置不回收（posting 数组仍指向该下标，query 时跳过 null） */
  docs: (BlockDoc | null)[];
  /** fileId -> 该文件当前存活的 docId 集合，增量更新 / 删除时定位并 tombstone */
  docsByFile: Map<number, Set<number>>;
  /** term -> 有序 docId 数组。term 形如 `op:insert` / `wtable:<id>` / `wcol:<tableId>.<colId>` / `rtable:<id>` */
  inverted: Map<string, number[]>;
  /** tableId -> 该表出现过的 writeColumn columnId 集合，供前端"选表后再选列"的范围收窄用 */
  tableColumns: Map<number, Set<number>>;
  unsubscribeWatcher: () => void;
  broadcastTimer: ReturnType<typeof setTimeout> | null;
  buildReady: Promise<void>;
  state: "building" | "ready" | "error";
  totalFiles: number;
  processedFiles: number;
  errorMessage: string | null;
}

let runtime: Runtime | null = null;
let broadcaster: ((channel: string) => void) | null = null;

export function setBroadcaster(fn: (channel: string) => void): void {
  broadcaster = fn;
}

function scheduleBroadcast(rt: Runtime): void {
  if (rt.broadcastTimer) return;
  rt.broadcastTimer = setTimeout(() => {
    rt.broadcastTimer = null;
    if (!broadcaster) return;
    try {
      broadcaster(IPC_EVENTS.SQL_INDEX_CHANGED);
    } catch (err) {
      log.warn("SQL_INDEX_CHANGED broadcast failed", {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }, BROADCAST_DEBOUNCE_MS);
}

// ---------- vault walk（对齐 search.ts / vault-index.ts 的过滤规则） ----------

async function* walkMarkdown(root: string): AsyncGenerator<string> {
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (stack.length > 0) {
    const top = stack.pop();
    if (!top) break;
    const { dir, depth } = top;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const name = ent.name;
      if (depth > 0 && name.startsWith(".")) continue;
      if (["node_modules", "target", "dist", "build", "__pycache__"].includes(name)) continue;
      const full = path.join(dir, name);
      if (ent.isDirectory()) {
        stack.push({ dir: full, depth: depth + 1 });
      } else if (ent.isFile() && STELA_EXTS.has(path.extname(name).toLowerCase())) {
        yield full;
      }
    }
  }
}

function toRelKey(absPath: string, vaultPath: string): string | null {
  const rel = path.relative(vaultPath, absPath).replace(/\\/g, "/");
  if (!rel || rel.startsWith("..")) return null;
  return rel;
}

function lineOfOffset(content: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content.charCodeAt(i) === 10 /* \n */) line++;
  }
  return line;
}

// ---------- 连接 / 方言解析 ----------

interface ConnectionsSnapshot {
  connections: ConnectionMap;
  kinds: ConnectorKindMeta[];
}

async function loadConnectionsSnapshot(rt: Runtime): Promise<ConnectionsSnapshot> {
  try {
    const connections = await connectionsStore.loadConnections(rt.vaultPath, rt.slug);
    const kinds = connectorRegistry.listKinds();
    return { connections, kinds };
  } catch (err) {
    log.warn("load connections snapshot failed", {
      err: err instanceof Error ? err.message : String(err),
    });
    return { connections: {}, kinds: [] };
  }
}

function resolveConnectionDialect(
  snapshot: ConnectionsSnapshot,
  connectionName: string | null,
): { dialectName: string | null } {
  if (!connectionName) return { dialectName: null };
  const entry = snapshot.connections[connectionName];
  if (!entry) return { dialectName: null };
  const meta = snapshot.kinds.find((k) => k.kind === entry.kind);
  const displayName = meta?.displayName ?? entry.kind;
  return {
    dialectName: resolveDialect({ kind: entry.kind, displayName, dialect: meta?.dialect }),
  };
}

// ---------- 表 / 列归一化 + 倒排写入 ----------

function normalizedTableKeys(ref: TableRef): { bare: string; qualified: string | null } {
  const bare = ref.table.toLowerCase();
  const qualified = ref.db ? `${ref.db.toLowerCase()}.${bare}` : null;
  return { bare, qualified };
}

function pushSorted(arr: number[], docId: number): void {
  // docId 单调递增分配，正常路径下天然有序；防御性检查避免极端情况下重复 push。
  if (arr.length > 0 && arr[arr.length - 1] === docId) return;
  arr.push(docId);
}

function addPosting(rt: Runtime, term: string, docId: number): void {
  let arr = rt.inverted.get(term);
  if (!arr) {
    arr = [];
    rt.inverted.set(term, arr);
  }
  pushSorted(arr, docId);
}

/** 记录 tableId 下出现过的列，供 facets() 里"选表后列名范围收窄"用。只增不减（tombstone 不清理，与 Interner 一致）。 */
function recordTableColumn(rt: Runtime, tableId: number, columnId: number): void {
  let set = rt.tableColumns.get(tableId);
  if (!set) {
    set = new Set();
    rt.tableColumns.set(tableId, set);
  }
  set.add(columnId);
}

/** 解析一条语句事实，写入 docId 对应的 StoredStatement + 倒排 posting。 */
function indexStatement(rt: Runtime, docId: number, stmt: StatementFacts): StoredStatement {
  const readTableIds: number[] = [];
  for (const ref of stmt.readTables) {
    const { bare, qualified } = normalizedTableKeys(ref);
    const bareId = rt.tables.intern(bare);
    readTableIds.push(bareId);
    addPosting(rt, `rtable:${bareId}`, docId);
    if (qualified) {
      const qId = rt.tables.intern(qualified);
      addPosting(rt, `rtable:${qId}`, docId);
    }
  }

  const writeTableIds: number[] = [];
  for (const ref of stmt.writeTables) {
    const { bare, qualified } = normalizedTableKeys(ref);
    const bareId = rt.tables.intern(bare);
    writeTableIds.push(bareId);
    addPosting(rt, `wtable:${bareId}`, docId);
    if (qualified) {
      const qId = rt.tables.intern(qualified);
      addPosting(rt, `wtable:${qId}`, docId);
    }
  }

  const writeColumns: StoredColumnRef[] = [];
  const seenCol = new Set<string>();
  for (const col of stmt.writeColumns) {
    const columnId = rt.columns.intern(col.column.toLowerCase());
    const tableId = col.table ? rt.tables.intern(col.table.toLowerCase()) : null;
    writeColumns.push({ tableId, columnId });
    if (tableId !== null) {
      const key = `${tableId}.${columnId}`;
      if (!seenCol.has(key)) {
        seenCol.add(key);
        addPosting(rt, `wcol:${key}`, docId);
      }
      recordTableColumn(rt, tableId, columnId);
    }
    // 同 wtable/rtable：列也要建 `db.table` 限定名的 posting，否则
    // `writeColumn.table` 传限定名（比如 BigQuery/StarRocks 的 `dataset.table`）
    // 时 query() 侧 lookup 到的是限定名的 tableId，永远查不到只用裸表名建的
    // posting，表现为"确定性索引明明有数据却查不出来"。
    if (col.table && col.db) {
      const qualifiedTableId = rt.tables.intern(`${col.db.toLowerCase()}.${col.table.toLowerCase()}`);
      const qKey = `${qualifiedTableId}.${columnId}`;
      if (!seenCol.has(qKey)) {
        seenCol.add(qKey);
        addPosting(rt, `wcol:${qKey}`, docId);
      }
      recordTableColumn(rt, qualifiedTableId, columnId);
    }
  }

  addPosting(rt, `op:${stmt.operation}`, docId);

  return { operation: stmt.operation, readTableIds, writeTableIds, writeColumns };
}

// ---------- 文件解析 ----------

async function parseFile(
  absPath: string,
  rt: Runtime,
  snapshot: ConnectionsSnapshot,
): Promise<void> {
  let stat;
  try {
    stat = await fs.stat(absPath);
  } catch {
    return;
  }
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return;
  const relPath = toRelKey(absPath, rt.vaultPath);
  if (!relPath) return;

  let content: string;
  try {
    content = await fs.readFile(absPath, "utf-8");
  } catch {
    return;
  }

  const fences = parseRunsqlFences(content);
  if (fences.length === 0) return;

  const { frontmatter } = splitFrontmatter(content);
  const connectionName = parseFrontmatterField(frontmatter, "connection_name");
  const { dialectName } = resolveConnectionDialect(snapshot, connectionName);
  const dialect = lezerDialectFor(dialectName);

  const fileId = rt.files.intern(relPath);
  const connId = connectionName ? rt.connections.intern(connectionName) : null;
  const dialectId = dialectName ? rt.dialects.intern(dialectName) : null;

  let fileDocs = rt.docsByFile.get(fileId);
  if (!fileDocs) {
    fileDocs = new Set();
    rt.docsByFile.set(fileId, fileDocs);
  }

  for (const fence of fences) {
    if (!fence.sql.trim()) continue;
    let statements: StatementFacts[];
    try {
      statements = extractSqlFacts(fence.sql, { dialect });
    } catch (err) {
      log.warn("extractSqlFacts failed", {
        relPath,
        blockIndex: fence.index,
        err: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    const docId = rt.docs.length;
    const stored: StoredStatement[] = [];
    for (const stmt of statements) {
      stored.push(indexStatement(rt, docId, stmt));
    }

    const doc: BlockDoc = {
      fileId,
      blockIndex: fence.index,
      line: lineOfOffset(content, fence.codeStart),
      codeStart: fence.codeStart,
      codeEnd: fence.codeEnd,
      blockId: fence.blockId,
      connId,
      dialectId,
      runDate: fence.detail?.runDate || null,
      statements: stored,
    };
    rt.docs.push(doc);
    fileDocs.add(docId);
  }
}

/** tombstone 一个文件当前所有 doc（增量重解析 / 删除时先调用）。 */
function dropFileDocs(rt: Runtime, fileId: number): void {
  const ids = rt.docsByFile.get(fileId);
  if (!ids || ids.size === 0) return;
  for (const id of ids) {
    rt.docs[id] = null;
  }
  rt.docsByFile.delete(fileId);
}

// ---------- 全量扫描 / 增量更新 ----------

async function fullScan(rt: Runtime): Promise<void> {
  const start = Date.now();
  const files: string[] = [];
  for await (const f of walkMarkdown(rt.vaultPath)) files.push(f);
  rt.totalFiles = files.length;
  rt.processedFiles = 0;

  const snapshot = await loadConnectionsSnapshot(rt);
  for (const file of files) {
    await parseFile(file, rt, snapshot);
    rt.processedFiles += 1;
  }

  rt.state = "ready";
  log.info("sql-index full scan done", {
    vaultPath: rt.vaultPath,
    files: files.length,
    blocks: rt.docs.length,
    elapsedMs: Date.now() - start,
  });
}

async function handleWatchBatch(
  rt: Runtime,
  events: Array<{ type: string; path: string; isDir: boolean }>,
): Promise<void> {
  const touched = new Map<string, "removed" | "upsert">();
  for (const ev of events) {
    if (ev.isDir) continue;
    if (STELA_EXTS.has(path.extname(ev.path).toLowerCase())) {
      touched.set(ev.path, ev.type === "removed" ? "removed" : "upsert");
    }
  }
  if (touched.size === 0) return;

  const snapshot = await loadConnectionsSnapshot(rt);
  let changed = false;
  for (const [absPath, kind] of touched) {
    const relPath = toRelKey(absPath, rt.vaultPath);
    if (!relPath) continue;
    const fileId = rt.files.lookup(relPath);
    if (fileId !== null) dropFileDocs(rt, fileId);
    if (kind === "upsert") {
      await parseFile(absPath, rt, snapshot);
    }
    changed = true;
  }
  if (changed) scheduleBroadcast(rt);
}

// ---------- 公共 API（handlers.ts 调用） ----------

export async function start(vaultPath: string | null): Promise<void> {
  await stop();
  if (!vaultPath) return;

  const slug = await deviceProfile.loadDeviceProfile().then(
    (p) => p.slug,
    () => "device",
  );

  const rt: Runtime = {
    vaultPath,
    slug,
    tables: new Interner(),
    columns: new Interner(),
    connections: new Interner(),
    dialects: new Interner(),
    files: new Interner(),
    docs: [],
    docsByFile: new Map(),
    inverted: new Map(),
    tableColumns: new Map(),
    unsubscribeWatcher: () => {},
    broadcastTimer: null,
    buildReady: Promise.resolve(),
    state: "building",
    totalFiles: 0,
    processedFiles: 0,
    errorMessage: null,
  };

  rt.unsubscribeWatcher = vaultWatcher.subscribe((payload) => {
    if (!runtime || runtime.vaultPath !== payload.vaultPath) return;
    void handleWatchBatch(runtime, payload.events);
  });

  rt.buildReady = fullScan(rt).then(
    () => {
      scheduleBroadcast(rt);
    },
    (err: unknown) => {
      rt.state = "error";
      rt.errorMessage = err instanceof Error ? err.message : String(err);
      log.error("sql-index full scan failed", { vaultPath, err: rt.errorMessage });
    },
  );

  runtime = rt;
}

export async function stop(): Promise<void> {
  if (!runtime) return;
  const rt = runtime;
  runtime = null;
  if (rt.broadcastTimer) {
    clearTimeout(rt.broadcastTimer);
    rt.broadcastTimer = null;
  }
  try {
    rt.unsubscribeWatcher();
  } catch {
    /* noop */
  }
  rt.docs.length = 0;
  rt.docsByFile.clear();
  rt.inverted.clear();
  rt.tableColumns.clear();
  rt.tables.clear();
  rt.columns.clear();
  rt.connections.clear();
  rt.dialects.clear();
  rt.files.clear();
}

export function status(): SqlIndexStatus {
  if (!runtime) {
    return { state: "idle", processedFiles: 0, totalFiles: 0, blockCount: 0, error: null };
  }
  return {
    state: runtime.state === "ready" ? "ready" : runtime.state === "error" ? "error" : "building",
    processedFiles: runtime.processedFiles,
    totalFiles: runtime.totalFiles,
    blockCount: runtime.docs.filter((d) => d !== null).length,
    error: runtime.errorMessage,
  };
}

export async function facets(): Promise<SqlIndexFacets> {
  if (!runtime) {
    return { tables: [], columns: [], connections: [], operations: [], tableColumns: {} };
  }
  await runtime.buildReady;
  const rt = runtime;
  const operations: SqlIndexOperation[] = [
    "select",
    "insert",
    "replace",
    "update",
    "delete",
    "upsert",
    "ddl",
    "other",
  ].filter((op) => rt.inverted.has(`op:${op}`)) as SqlIndexOperation[];

  const tableColumns: Record<string, string[]> = {};
  for (const [tableId, colIds] of rt.tableColumns) {
    const tableName = rt.tables.get(tableId);
    tableColumns[tableName] = [...colIds].map((id) => rt.columns.get(id)).sort();
  }

  return {
    tables: rt.tables.values().sort(),
    columns: rt.columns.values().sort(),
    connections: rt.connections.values().sort(),
    operations,
    tableColumns,
  };
}

/** 有序整型数组求交集（多个 posting 同时满足）。任一为空直接短路返回空。 */
function intersectSorted(lists: number[][]): number[] {
  if (lists.length === 0) return [];
  if (lists.some((l) => l.length === 0)) return [];
  let acc = lists[0]!;
  for (let i = 1; i < lists.length; i++) {
    acc = intersectTwo(acc, lists[i]!);
    if (acc.length === 0) return acc;
  }
  return acc;
}

function intersectTwo(a: number[], b: number[]): number[] {
  const out: number[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i]! === b[j]!) {
      out.push(a[i]!);
      i++;
      j++;
    } else if (a[i]! < b[j]!) {
      i++;
    } else {
      j++;
    }
  }
  return out;
}

function unionSorted(lists: number[][]): number[] {
  const set = new Set<number>();
  for (const l of lists) for (const id of l) set.add(id);
  return [...set].sort((x, y) => x - y);
}

export async function query(filter: SqlIndexFilter): Promise<SqlIndexHit[]> {
  if (!runtime) return [];
  await runtime.buildReady;
  const rt = runtime;
  const maxHits = Math.max(1, Math.min(filter.maxHits ?? DEFAULT_MAX_HITS, 2000));

  const postings: number[][] = [];

  if (filter.operations && filter.operations.length > 0) {
    postings.push(unionSorted(filter.operations.map((op) => rt.inverted.get(`op:${op}`) ?? [])));
  }
  if (filter.readTable) {
    const id = rt.tables.lookup(normalizeTableFilterKey(filter.readTable));
    postings.push(id === null ? [] : (rt.inverted.get(`rtable:${id}`) ?? []));
  }
  if (filter.writeTable) {
    const id = rt.tables.lookup(normalizeTableFilterKey(filter.writeTable));
    postings.push(id === null ? [] : (rt.inverted.get(`wtable:${id}`) ?? []));
  }
  if (filter.writeColumn) {
    const tableId = rt.tables.lookup(filter.writeColumn.table.toLowerCase());
    const colId = rt.columns.lookup(filter.writeColumn.column.toLowerCase());
    postings.push(
      tableId === null || colId === null ? [] : (rt.inverted.get(`wcol:${tableId}.${colId}`) ?? []),
    );
  }

  const docIds = postings.length > 0 ? intersectSorted(postings) : allDocIds(rt);

  const hits: SqlIndexHit[] = [];
  const fileCache = new Map<number, string | null>();
  for (const docId of docIds) {
    if (hits.length >= maxHits) break;
    const doc = rt.docs[docId];
    if (!doc) continue;
    const hit = await buildHit(rt, docId, doc, fileCache);
    if (hit) hits.push(hit);
  }
  return hits;
}

function allDocIds(rt: Runtime): number[] {
  const out: number[] = [];
  for (let i = 0; i < rt.docs.length; i++) if (rt.docs[i]) out.push(i);
  return out;
}

/** 过滤用表名归一化：裸表名原样小写；db.table 形式也小写整体（与索引写入时一致）。 */
function normalizeTableFilterKey(input: string): string {
  return input.toLowerCase();
}

async function buildHit(
  rt: Runtime,
  _docId: number,
  doc: BlockDoc,
  fileCache: Map<number, string | null>,
): Promise<SqlIndexHit | null> {
  const relPath = rt.files.get(doc.fileId);
  const absPath = path.join(rt.vaultPath, relPath);

  let content = fileCache.get(doc.fileId);
  if (content === undefined) {
    try {
      content = await fs.readFile(absPath, "utf-8");
    } catch {
      content = null;
    }
    fileCache.set(doc.fileId, content);
  }

  let snippet = "";
  if (content !== null) {
    const raw = content.slice(doc.codeStart, doc.codeEnd);
    snippet = raw.length > SNIPPET_MAX_CHARS ? `${raw.slice(0, SNIPPET_MAX_CHARS)}…` : raw;
  }

  const operations = [...new Set(doc.statements.map((s) => s.operation))];

  return {
    path: absPath,
    relPath,
    blockIndex: doc.blockIndex,
    line: doc.line,
    blockId: doc.blockId,
    connectionName: doc.connId !== null ? rt.connections.get(doc.connId) : null,
    dialect: doc.dialectId !== null ? rt.dialects.get(doc.dialectId) : null,
    runDate: doc.runDate,
    operations,
    snippet,
  };
}
