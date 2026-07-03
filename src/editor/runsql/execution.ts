/**
 * RunSQL 执行环路。
 *
 * 流程：
 *   1. 取出 attrs.blockId，没有就 generateBlockId() 写回
 *   2. 取 sql = node.textContent；从 RunContext 拿 connection_name
 *   3. const conn = useConnections.getState().get(name); 没有 → toast 报错
 *   4. setNodeMarkup({ runState: "running" })
 *   5. const result = await connectorRegistry.execute(conn.kind, conn.config, sql)
 *   6. const runId = uuid()
 *      storage.saveRun({ ... }); storage.saveSchema(runId, columns); storage.saveRows(runId, rows)
 *   7. const meta: DetailMeta = { ... }; const detailRaw = serializeDetail(meta)
 *      setNodeMarkup({ detail, detailRaw, runState: "idle" })
 *   8. setNodeMarkup 触发 markdownUpdated → MilkdownEditor 的 listener 自动落盘
 *   9. resultPanel.show(runId)
 *
 * 错误兜底：捕获后 setNodeMarkup({ runState: "error" })，footer 显示 message，
 * 不写 detail（避免污染 round-trip）。
 */

import type { Node as ProseNode } from "@milkdown/prose/model";
import { TextSelection } from "@milkdown/prose/state";
import type { EditorView as PMView } from "@milkdown/prose/view";

import type { ColumnDef, QueryResult, RunRecord } from "@/contracts";
import { generateBlockId, type DetailMeta } from "@/core/types";
import { electronConnectorRegistry } from "@/services/connectors/electron-connector";
import { scheduleAutoGit } from "@/services/auto-git";
import { readFile } from "@/services/fs";
import { writeFile } from "@/services/fs-write";
import { getKnownDiskContent } from "@/services/note-save-tracker";
import { electronStorage } from "@/services/storage/electron-storage";
import {
  getTabBuffer,
  scheduleTabPersist,
  setTabBuffer,
} from "@/state/tab-buffer";
import { useConnections } from "@/state/connections";
import { useWorkspace } from "@/state/workspace";
import {
  MAX_INLINE_RESULT_BYTES,
  TRUNCATED_MESSAGE_PREFIX,
} from "@shared/journal-limits";

import { serializeDetail } from "./detail-meta";
import { patchRunsqlDetail } from "./markdown-patch";
import { beginPendingRun, endPendingRun } from "./pending-runs";
import { flushAllRunsqlEditors, RUNSQL_LANGUAGE } from "./codeblock-nodeview";
import { getRunContext } from "./run-context";

export interface RunOutcome {
  ok: boolean;
  message?: string;
  runId?: string;
}

function uuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(2)}s`;
  const m = Math.floor(s / 60);
  return `${m}m${Math.round(s - m * 60)}s`;
}

function nowIso(): string {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function setAttrs(
  view: PMView,
  getPos: () => number | undefined,
  patch: Record<string, unknown>,
): void {
  if (!isViewWritable(view)) return;
  const pos = getPos();
  if (pos === undefined) return;
  const node = view.state.doc.nodeAt(pos);
  if (!node) return;
  const tr = view.state.tr.setNodeMarkup(pos, undefined, {
    ...node.attrs,
    ...patch,
  });
  view.dispatch(tr);
}

function isViewWritable(view: PMView): boolean {
  return view.dom.isConnected;
}

export async function runBlock(
  node: ProseNode,
  view: PMView,
  getPos: () => number | undefined,
): Promise<RunOutcome> {
  const ctx = getRunContext();
  const path = ctx?.path ?? null;
  const tabId = path ? useWorkspace.getState().getTabIdByPath(path) : null;
  if (!ctx?.connectionName) {
    setAttrs(view, getPos, { runState: "error" });
    return {
      ok: false,
      message:
        "frontmatter.connection_name 未配置，无法执行。请在文件顶部 YAML 中加入 connection_name: <你的连接名>。",
    };
  }
  const entry = useConnections.getState().get(ctx.connectionName);
  if (!entry) {
    setAttrs(view, getPos, { runState: "error" });
    return {
      ok: false,
      message: `未找到连接 '${ctx.connectionName}'。请先在连接管理中添加（或手编 stela-connections.json）。`,
    };
  }

  let blockId = (node.attrs.blockId as string | undefined) ?? "";
  if (!blockId) {
    blockId = generateBlockId();
    setAttrs(view, getPos, { blockId });
  }
  const sql = node.textContent.trim();
  if (!sql) {
    setAttrs(view, getPos, { runState: "error" });
    return { ok: false, message: "SQL 为空。" };
  }

  const blockIndex = findRunsqlBlockIndex(view.state.doc, getPos());
  if (tabId) useWorkspace.getState().incrementSqlRunning(tabId);
  const pendingRunKey = tabId
    ? beginPendingRun({ tabId, blockId, blockIndex, sql })
    : null;
  setAttrs(view, getPos, { runState: "running" });

  const startedAt = Date.now();
  let result: QueryResult;
  try {
    result = await electronConnectorRegistry.execute(
      entry.kind,
      entry.config,
      sql,
    );
  } catch (err) {
    const message = errMsg(err);
    setAttrs(view, getPos, { runState: "error" });
    await persistFailedRun(
      blockId,
      sql,
      ctx.connectionName,
      startedAt,
      message,
      path,
    );
    endPendingRun(pendingRunKey);
    if (tabId) useWorkspace.getState().decrementSqlRunning(tabId);
    return { ok: false, message };
  }

  const runId = uuid();
  const elapsedMs = result.elapsedMs;
  const rowCount =
    result.kind === "query" ? result.rows.length : result.affectedRows;
  const columns: ColumnDef[] = result.kind === "query" ? result.columns : [];
  const firstRow = extractFirstRow(result);

  // 估算 rows JSON 字节：超阈值则跳过 saveRows，避免本机 SQLite 暴涨。
  // 同步出去的 JSONL 也会在 buildJournalLine 兜底截断。
  // 用 JSON.stringify 而不是逐行累加：单行宽度本身可能极大（一行 JSON 含
  //   长字符串/嵌套对象），逐行 estimate 容易低估。
  let truncated = false;
  let rowsBytes = 0;
  if (result.kind === "query" && result.rows.length > 0) {
    rowsBytes = JSON.stringify(result.rows).length;
    if (rowsBytes > MAX_INLINE_RESULT_BYTES) {
      truncated = true;
    }
  }

  const record: RunRecord = {
    runId,
    blockId,
    sql,
    status: "ok",
    message: truncated
      ? `${TRUNCATED_MESSAGE_PREFIX}: rowCount=${rowCount}, rowsBytes=${rowsBytes} > ${MAX_INLINE_RESULT_BYTES}`
      : null,
    startedAt,
    elapsedMs,
    rowCount,
    connectionName: ctx.connectionName,
    notePath: path,
  };
  try {
    await electronStorage.saveRun(record);
    if (result.kind === "query") {
      await electronStorage.saveSchema(runId, columns);
      if (!truncated) {
        await electronStorage.saveRows(runId, result.rows);
      }
    }
    await appendRunToJournal(runId);
  } catch (err) {
    console.error("[stela] storage write failed", err);
  }

  const detail: DetailMeta = {
    blockId,
    runDate: nowIso(),
    elapsed: formatElapsed(elapsedMs),
    rowCount,
    firstRow,
    resultRefId: runId,
  };
  const detailRaw = serializeDetail(detail);
  try {
    if (isViewWritable(view)) {
      setAttrs(view, getPos, {
        detail,
        detailRaw,
        runState: "idle",
      });
    } else if (path) {
      await writeDetailToMarkdownBuffer({
        path,
        tabId,
        blockId,
        blockIndex,
        sql,
        detailRaw,
      });
    }
  } finally {
    endPendingRun(pendingRunKey);
    if (tabId) useWorkspace.getState().decrementSqlRunning(tabId);
  }
  // 结果展示由 RunSQL NodeView 自身的 BlockResult 区域负责（按 detail.resultRefId
  // 渲染表格，存进 SQLite 不必再通过全局 panel 通知）。
  return { ok: true, runId };
}

export interface RunAllOutcome {
  /** 文档内非空 runsql 块总数 */
  total: number;
  /** 实际执行次数 */
  ran: number;
  /** 失败次数 */
  failed: number;
  /** 失败原因（按块顺序） */
  messages: string[];
}

function isRunsqlBlock(node: ProseNode): boolean {
  return (
    node.type.name === "code_block" &&
    (node.attrs.language as string | undefined) === RUNSQL_LANGUAGE
  );
}

function findRunsqlBlockIndex(doc: ProseNode, targetPos: number | undefined): number {
  if (targetPos === undefined) return 0;
  let index = 0;
  let found = 0;
  doc.descendants((node, pos) => {
    if (!isRunsqlBlock(node) || !node.textContent.trim()) return;
    if (pos === targetPos) {
      found = index;
      return false;
    }
    index++;
    return;
  });
  return found;
}

async function writeDetailToMarkdownBuffer({
  path,
  tabId,
  blockId,
  blockIndex,
  sql,
  detailRaw,
}: {
  path: string;
  tabId: string | null;
  blockId: string;
  blockIndex: number;
  sql: string;
  detailRaw: string;
}): Promise<void> {
  const raw =
    (tabId ? getTabBuffer(tabId) : undefined) ??
    getKnownDiskContent(path) ??
    (await readFile(path));
  const next = patchRunsqlDetail(raw, {
    blockId,
    blockIndex,
    sql,
    detailRaw,
  });
  if (next === raw) return;

  if (!tabId) {
    await writeFile(path, next);
    return;
  }

  const workspace = useWorkspace.getState();
  setTabBuffer(tabId, next);
  workspace.setDirty(tabId, true);
  scheduleTabPersist(tabId, path, next, () =>
    useWorkspace.getState().setDirty(tabId, false),
  );
  workspace.reloadTabFromBuffer(tabId);
}

/**
 * 在当前光标处插入一个空 runsql 代码块，并把光标移进块内，方便立刻打字写 SQL。
 *
 * 由「插入 SQL 块」快捷键（EditorView 的 `Mod+Shift+S`）与命令面板入口共用。
 *
 * 落点策略：
 *  - 光标停在**顶层空段落**里 → 直接把该段落替换成 runsql 块（与 slash「执行 SQL」一致，
 *    不留多余空行）
 *  - 其它情况（含焦点在已有 runsql 块的 CM6 子编辑器内，此时 PM 选区是顶层 NodeSelection）
 *    → 在光标所在顶层 block 之后插入新块
 *
 * 返回 false 仅当 schema 缺少 `code_block`（理论不会发生），调用方可忽略。
 */
export function insertRunSqlBlock(view: PMView): boolean {
  const { state } = view;
  const codeType = state.schema.nodes.code_block;
  if (!codeType) return false;

  const code = codeType.create({ language: RUNSQL_LANGUAGE, runState: "idle" });
  const { $from } = state.selection;
  const tr = state.tr;

  const inEmptyTopParagraph =
    $from.depth === 1 &&
    $from.parent.type.name === "paragraph" &&
    $from.parent.content.size === 0;

  let codeStart: number;
  if (inEmptyTopParagraph) {
    codeStart = $from.before(1);
    tr.replaceWith(codeStart, $from.after(1), code);
  } else {
    // depth 0 表示顶层 NodeSelection（焦点在已有块上），selection.to 即该块之后
    codeStart = $from.depth === 0 ? state.selection.to : $from.after(1);
    tr.insert(codeStart, code);
  }

  // codeStart 指向新块的节点边界，+1 落进块内容
  tr.setSelection(TextSelection.near(tr.doc.resolve(codeStart + 1)));
  tr.scrollIntoView();
  view.dispatch(tr);
  view.focus();
  return true;
}

/** 顺序重跑当前文档内全部非空 runsql 块。 */
export async function runAllBlocks(view: PMView): Promise<RunAllOutcome> {
  flushAllRunsqlEditors();

  const outcome: RunAllOutcome = { total: 0, ran: 0, failed: 0, messages: [] };
  const blocks: Array<{ pos: number; node: ProseNode }> = [];
  view.state.doc.descendants((node, pos) => {
    if (isRunsqlBlock(node) && node.textContent.trim()) {
      blocks.push({ pos, node });
    }
  });
  outcome.total = blocks.length;

  if (outcome.total === 0) return outcome;

  for (const { pos, node } of blocks) {
    const result = await runBlock(node, view, () => pos);
    outcome.ran++;
    if (!result.ok) {
      outcome.failed++;
      if (result.message) outcome.messages.push(result.message);
    }
  }

  return outcome;
}

async function persistFailedRun(
  blockId: string,
  sql: string,
  connectionName: string,
  startedAt: number,
  message: string,
  notePath: string | null,
): Promise<void> {
  const runId = uuid();
  try {
    await electronStorage.saveRun({
      runId,
      blockId,
      sql,
      status: "err",
      message,
      startedAt,
      elapsedMs: Date.now() - startedAt,
      rowCount: 0,
      connectionName,
      notePath,
    });
    await appendRunToJournal(runId);
  } catch (err) {
    console.error("[stela] failed to persist err run", err);
  }
}

/**
 * 把刚写入 SQLite 的 run 追加到本设备执行历史 JSONL（跨设备同步真相源）。
 * 失败不影响执行：JSONL 缺失最坏只是该 run 不跨设备，可后续 rebuild 补。
 */
async function appendRunToJournal(runId: string): Promise<void> {
  try {
    await window.stela.journal.appendRun(runId);
    scheduleAutoGit("runsql-journal");
  } catch (err) {
    console.error("[stela] journal append failed", err);
  }
}

function extractFirstRow(result: QueryResult): Record<string, unknown> | null {
  if (result.kind !== "query") return null;
  if (result.rows.length === 0 || result.columns.length === 0) return null;
  const obj: Record<string, unknown> = {};
  result.columns.forEach((col, i) => {
    obj[col.name] = result.rows[0][i] ?? null;
  });
  return obj;
}

function errMsg(err: unknown): string {
  if (err && typeof err === "object") {
    const anyE = err as { message?: unknown };
    if (typeof anyE.message === "string" && anyE.message.length > 0) {
      // main 端 ipc-router 已经把 code 编进 message 前缀（[code] message），
      // renderer 直接用 message 就够了，不再手动拼 code，避免双重前缀。
      return anyE.message;
    }
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}
