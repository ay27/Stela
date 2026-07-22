/**
 * 笔记 Markdown 导出核心逻辑。
 *
 * 流程：
 *   1. 读取笔记原文（plain text），用纯文本扫描定位每个 fenced code block + 紧邻
 *      `<detail>...</detail>` 的 RunSQL pair。
 *   2. 并发（上限 4）拉取每个 runId 的前 N 行（通过 `loadResultPage`，含远端回灌 fallback）。
 *   3. 将 `<detail>` HTML 替换为 GFM Markdown 表格（含 blockquote 元信息摘要）。
 *      - 无结果集 → `> 无结果集（mutation 或 0 rows）`
 *      - 数据缺失（拉取失败）→ 保留原 `<detail>` HTML + 警告 blockquote
 *   4. 调 `window.stela.export.saveMarkdown` 弹原生 Save 对话框写出。
 *
 * 不修改原文件；所有输出写到用户选择的目标路径。
 */

import type { ColumnDef, RunRecord } from "@/contracts";
import type { DetailMeta } from "@/core/types";
import { matchDetail, parseDetail } from "@/editor/runsql/detail-meta";
import { loadResultPage, type ResultLoaderDeps } from "@/services/result-loader";
import { computeResultDiff } from "@/services/result-diff";
import { electronStorage } from "@/services/storage/electron-storage";

// ─── 公开常量 ────────────────────────────────────────────────────────────────

export const EXPORT_ROW_CAP_OPTIONS = [5, 10, 20, 50, 100, null] as const;
export type ExportRowCap = (typeof EXPORT_ROW_CAP_OPTIONS)[number];
/** null = 全部；显示文案用 */
export function rowCapLabel(cap: ExportRowCap): string {
  return cap === null ? "全部" : String(cap);
}

/** 导出的结果范围。latest 与今天行为一致（每块一张表）。 */
export type ExportRunScope =
  | { kind: "latest" }
  | { kind: "recent"; count: number }
  | { kind: "all" };

export interface ExportMarkdownLabels {
  noResult: string;
  resultTitle: string;
  rowSummary: (visible: number | null, total: number) => string;
  latestPrefix: string;
  historySummary: (count: number) => string;
  executionFailed: (reason: string) => string;
  missingData: (runId: string) => string;
  diffTitle: (previousTime: string, latestTime: string) => string;
  diffStats: (added: number, removed: number, changed: number) => string;
  schemaMismatch: string;
  diffColumnHeader: string;
  diffBaselineHeader: string;
  diffCurrentHeader: string;
  diffStatusHeader: string;
}

export const DEFAULT_EXPORT_MARKDOWN_LABELS: ExportMarkdownLabels = {
  noResult: "> No result set (mutation or 0 rows)",
  resultTitle: "Result",
  rowSummary: (visible, total) =>
    visible !== null && total > visible
      ? `first ${visible} / ${total} rows`
      : `${total} rows total`,
  latestPrefix: "**Latest** · ",
  historySummary: (count) => `Execution history (${count} older runs)`,
  executionFailed: (reason) => `> Execution failed: ${reason}`,
  missingData: (runId) => `> ⚠️ Result data missing (runId=${runId})`,
  diffTitle: (previousTime, latestTime) =>
    `> **Diff from previous version** (${previousTime} → ${latestTime})`,
  diffStats: (added, removed, changed) =>
    `> +${added} rows · -${removed} rows · ${changed} rows changed`,
  schemaMismatch: "\n> ⚠️ Result schemas differ",
  diffColumnHeader: "Column",
  diffBaselineHeader: "Baseline",
  diffCurrentHeader: "Current",
  diffStatusHeader: "Status",
};

/** runScope=all 时每个 block 最多导出的 run 数（体积护栏）。 */
export const EXPORT_MAX_ALL_RUNS = 50;

const EXPORT_BATCH_SIZE = 1000;

// ─── 类型 ─────────────────────────────────────────────────────────────────────

export interface RunsqlBlockInfo {
  /** fenced code block 结束位置（紧跟 ``` 那行的行尾，不含换行符本身） */
  codeBlockEnd: number;
  /** `<detail>` 整段（含标签）在 markdown 里的起始 offset */
  detailStart: number;
  /** `<detail>` 整段（含标签）在 markdown 里的结束 offset（exclusive） */
  detailEnd: number;
  detail: DetailMeta;
  /** 原始 `<detail>...</detail>` 文本，用于 fallback 保留 */
  detailRaw: string;
}

export interface ExportNoteOpts {
  filePath: string;
  rowCap: ExportRowCap;
  /** 结果范围；默认仅最新（与旧行为一致） */
  runScope?: ExportRunScope;
  /** 多历史时是否在最新表后追加「与上一版 diff」摘要；默认 false */
  includeDiffSummary?: boolean;
  /** 依赖注入，方便单测替换 */
  deps?: {
    readFile?: (path: string) => Promise<string>;
    loaderDeps?: ResultLoaderDeps;
    listRunsByBlockId?: (blockId: string) => Promise<RunRecord[]>;
    saveMarkdown?: (
      suggestedName: string,
      content: string,
      opts?: { title?: string },
    ) => Promise<{ canceled: boolean; path: string | null; revealToken?: string | null }>;
  };
  saveDialogTitle?: string;
  labels?: ExportMarkdownLabels;
}

export interface ExportNoteResult {
  canceled: boolean;
  savedPath: string | null;
  revealToken: string | null;
  /** 导出时有数据拉取失败的块数（已保留原 <detail>） */
  failedBlocks: number;
}

// ─── 解析 ─────────────────────────────────────────────────────────────────────

/**
 * 扫描 markdown 文本，找出所有 RunSQL pair：
 *   fenced code block 后紧跟（允许有空行）`<detail>...</detail>`。
 *
 * 不依赖 remark/milkdown；纯文本处理，避免引入重型解析器。
 *
 * 注意：
 *   - 支持多行 `<detail>` 块（跨行）
 *   - fenced block 之后允许若干空行
 *   - 同一个文件里多个 RunSQL 块按出现顺序返回
 */
export function parseRunsqlBlocks(md: string): RunsqlBlockInfo[] {
  const results: RunsqlBlockInfo[] = [];
  // 按行遍历，记录 fenced block 的开闭位置
  const lines = md.split("\n");

  let pos = 0; // 当前行在原始字符串里的字符偏移
  let inFence = false;
  let fenceOpenChar = "";
  let fenceOpenLen = 0;
  let codeBlockEnd = -1; // 最近一个 fenced block 结束后的字符偏移

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineEnd = pos + line.length; // 不含 '\n'

    if (!inFence) {
      // 寻找 fenced block 开头：``` 或 ~~~（允许开头有空格，保守不支持缩进）
      const fenceMatch = line.match(/^(`{3,}|~{3,})/);
      if (fenceMatch) {
        inFence = true;
        fenceOpenChar = fenceMatch[1][0];
        fenceOpenLen = fenceMatch[1].length;
      } else if (codeBlockEnd >= 0) {
        // 不在 fence 内，且上一个 fence 刚关闭——检测 <detail>
        const trimmed = line.trim();
        if (trimmed === "") {
          // 允许空行，继续
        } else if (trimmed.startsWith("<detail")) {
          // 可能是 detail 块的开始；在剩余 markdown 里找完整的 </detail>
          const searchFrom = pos;
          const closeTag = "</detail>";
          const closeIdx = md.indexOf(closeTag, searchFrom);
          if (closeIdx >= 0) {
            const detailEnd = closeIdx + closeTag.length;
            const detailRaw = md.slice(searchFrom, detailEnd);
            const matched = matchDetail(detailRaw);
            if (matched) {
              const detail = parseDetail(matched.inner);
              results.push({
                codeBlockEnd,
                detailStart: searchFrom,
                detailEnd,
                detail,
                detailRaw,
              });
            }
          }
          codeBlockEnd = -1;
        } else {
          // 非空行且不是 <detail>，重置
          codeBlockEnd = -1;
        }
      }
    } else {
      // 在 fence 内：寻找对应的关闭符
      const closeMatch = line.match(/^(`{3,}|~{3,})\s*$/);
      if (
        closeMatch &&
        closeMatch[1][0] === fenceOpenChar &&
        closeMatch[1].length >= fenceOpenLen
      ) {
        inFence = false;
        codeBlockEnd = lineEnd; // fence 关闭行（不含 '\n'）之后
        fenceOpenChar = "";
        fenceOpenLen = 0;
      }
    }

    pos = lineEnd + 1; // +1 for '\n'
  }

  return results;
}

/** 导出时将 Stela 专有语言标签 `runsql` 改写为标准 `sql`（仅 opening fence）。 */
export function rewriteRunsqlFencesToSql(md: string): string {
  return md.replace(/^```runsql\b/gm, "```sql");
}

const BR_TAG_RE = /<br\s*\/?>/gi;
const TABLE_ROW_RE = /^\s*\|/;

/**
 * Milkdown 序列化会写入 `<br />` 等 HTML 折行；导出时改为 GFM 兼容写法。
 *   - 表格行内 → 删除（空单元格占位，GFM 表格必须单行）
 *   - 独占一行 → 连同换行删除（前后空行已足够分段）
 *   - 其它行内 → 两空格 + 换行（GFM hard line break）
 */
export function normalizeExportHtmlTags(md: string): string {
  // 先处理表格行内的 <br>：GFM 表格必须单行，直接删占位（不能转 hard break）
  const tableStripped = md
    .split("\n")
    .map((line) => (TABLE_ROW_RE.test(line) ? line.replace(BR_TAG_RE, "") : line))
    .join("\n");
  // 独占一行的 <br>（连同换行）删除；行尾无换行的独占 <br> 删内容保留换行；行内 → 硬换行
  let out = tableStripped.replace(/^[ \t]*<br\s*\/?>[ \t]*\n/gm, "");
  out = out.replace(/^[ \t]*<br\s*\/?>[ \t]*$/gim, "");
  out = out.replace(BR_TAG_RE, "  \n");
  return out;
}

/** Milkdown 会对 `_` 等字符加反斜杠；导出为通用 Markdown 时在非代码区还原。 */
export function unescapeMilkdownLiterals(md: string): string {
  const segments = md.split(/(```[\s\S]*?```|`[^`\n]*`)/g);
  return segments
    .map((segment, i) => (i % 2 === 1 ? segment : segment.replace(/\\_/g, "_")))
    .join("");
}

/** 导出前对 markdown 正文做最后一轮兼容性归一化。 */
export function finalizeExportMarkdown(md: string): string {
  return unescapeMilkdownLiterals(
    normalizeExportHtmlTags(rewriteRunsqlFencesToSql(md)),
  );
}

// ─── GFM 表格渲染 ─────────────────────────────────────────────────────────────

/** 对 GFM 表格单元格里的特殊字符做转义。 */
function escapeMdCell(value: unknown): string {
  if (value === null || value === undefined) return "*NULL*";
  const s = typeof value === "object"
    ? (() => { try { return JSON.stringify(value); } catch { return String(value); } })()
    : String(value);
  // 转义 | 和 换行（用空格替换换行，让 markdown 表格保持单行）
  return s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

export function renderMarkdownTable(
  columns: ColumnDef[],
  rows: unknown[][],
): string {
  if (columns.length === 0) return "";
  const header = `| ${columns.map((c) => escapeMdCell(c.name)).join(" | ")} |`;
  const sep = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = rows.map(
    (row) =>
      `| ${columns.map((_, ci) => escapeMdCell(row[ci] ?? null)).join(" | ")} |`,
  );
  return [header, sep, ...body].join("\n");
}

/**
 * 构造替换 `<detail>` 的 markdown 片段。
 *
 * @param detail   - 解析后的 detail 元数据
 * @param columns  - 结果集 schema，为空表示 mutation / 无结果集
 * @param rows     - 实际拉取的行（已按 capN 截断）
 * @param total    - 结果集总行数（来自 storage）
 * @param capN     - 用户选择的行数上限（null = 全部）
 */
export function renderResultBlock(
  detail: DetailMeta,
  columns: ColumnDef[],
  rows: unknown[][],
  total: number,
  capN: ExportRowCap,
  labels: ExportMarkdownLabels = DEFAULT_EXPORT_MARKDOWN_LABELS,
): string {
  if (columns.length === 0) {
    return labels.noResult;
  }

  const parts: string[] = [];

  // 元信息摘要行
  const summaryParts: string[] = [];
  summaryParts.push(labels.rowSummary(capN, total));
  if (detail.runDate) summaryParts.push(detail.runDate);
  if (detail.elapsed) summaryParts.push(detail.elapsed);
  parts.push(`> ${labels.resultTitle} (${summaryParts.join(" · ")})`);
  parts.push("");
  parts.push(renderMarkdownTable(columns, rows));

  return parts.join("\n");
}

/** 单次执行拉取后的数据（多历史导出用）。 */
export interface FetchedRun {
  run: RunRecord;
  columns: ColumnDef[];
  rows: unknown[][];
  total: number;
  failed: boolean;
  failReason?: string;
}

function formatRunTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function runSummaryLine(
  item: FetchedRun,
  capN: ExportRowCap,
  prefix: string,
  labels: ExportMarkdownLabels,
): string {
  const parts: string[] = [];
  parts.push(labels.rowSummary(capN, item.total));
  parts.push(formatRunTime(item.run.startedAt));
  parts.push(`${item.run.elapsedMs}ms`);
  parts.push(`run \`${item.run.runId.slice(0, 8)}\``);
  return `> ${prefix}${parts.join(" · ")}`;
}

function renderSingleRunBody(
  item: FetchedRun,
  labels: ExportMarkdownLabels,
): string {
  if (item.failed) {
    return labels.executionFailed(item.failReason ?? "data missing");
  }
  if (item.columns.length === 0) {
    return labels.noResult;
  }
  return renderMarkdownTable(item.columns, item.rows);
}

/**
 * 多历史结果块：最新展开 + `<details>` 折叠更早执行。
 * runs 需按 startedAt 倒序（最新在前）。
 */
export function renderMultiRunResultBlock(
  runs: FetchedRun[],
  capN: ExportRowCap,
  labels: ExportMarkdownLabels = DEFAULT_EXPORT_MARKDOWN_LABELS,
): string {
  if (runs.length === 0) return labels.noResult;
  const [latest, ...older] = runs;

  const parts: string[] = [];
  parts.push(runSummaryLine(latest, capN, labels.latestPrefix, labels));
  parts.push("");
  parts.push(renderSingleRunBody(latest, labels));

  if (older.length > 0) {
    parts.push("");
    parts.push("<details>");
    parts.push(`<summary>${labels.historySummary(older.length)}</summary>`);
    parts.push("");
    for (const item of older) {
      parts.push(runSummaryLine(item, capN, "", labels));
      parts.push("");
      parts.push(renderSingleRunBody(item, labels));
      parts.push("");
    }
    parts.push("</details>");
  }

  return parts.join("\n");
}

/**
 * 「与上一版 diff」摘要：取最新两次成功执行，列出按列的旧值 → 新值。
 * 单行监控 SQL 输出 `列 | 基线 | 当前 | 状态`；多行结果退化为统计摘要行。
 * 任一侧无结果集则返回空串（不追加）。
 */
export function renderDiffSummaryBlock(
  latest: FetchedRun,
  previous: FetchedRun,
  labels: ExportMarkdownLabels = DEFAULT_EXPORT_MARKDOWN_LABELS,
): string {
  if (
    latest.failed ||
    previous.failed ||
    latest.columns.length === 0 ||
    previous.columns.length === 0
  ) {
    return "";
  }
  const diff = computeResultDiff(
    { columns: previous.columns, rows: previous.rows },
    { columns: latest.columns, rows: latest.rows },
  );
  const header = labels.diffTitle(
    formatRunTime(previous.run.startedAt),
    formatRunTime(latest.run.startedAt),
  );

  const singleRow =
    diff.rows.length === 1 &&
    diff.rows[0].kind === "matched" &&
    diff.stats.added === 0 &&
    diff.stats.removed === 0;

  if (!singleRow) {
    const stat = labels.diffStats(
      diff.stats.added,
      diff.stats.removed,
      diff.stats.changed,
    );
    const note = diff.schemaMatch ? "" : labels.schemaMismatch;
    return `${header}\n${stat}${note}`;
  }

  const row = diff.rows[0];
  const lines: string[] = [
    header,
    "",
    `| ${labels.diffColumnHeader} | ${labels.diffBaselineHeader} | ${labels.diffCurrentHeader} | ${labels.diffStatusHeader} |`,
    "| --- | --- | --- | --- |",
  ];
  diff.columns.forEach((col, idx) => {
    const status = row.cells[idx];
    const leftIdx = previous.columns.findIndex((c) => c.name === col.name);
    const rightIdx = latest.columns.findIndex((c) => c.name === col.name);
    const leftVal = leftIdx >= 0 && row.left ? row.left[leftIdx] : null;
    const rightVal = rightIdx >= 0 && row.right ? row.right[rightIdx] : null;
    lines.push(
      `| ${escapeMdCell(col.name)} | ${escapeMdCell(leftVal)} | ${escapeMdCell(rightVal)} | ${status} |`,
    );
  });
  return lines.join("\n");
}

// ─── 主流程 ───────────────────────────────────────────────────────────────────

function basename(p: string): string {
  return p.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? p;
}

function suggestExportName(filePath: string): string {
  const name = basename(filePath);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return `${stem}-export.md`;
}

/**
 * 并发池（同 schema-dump）：保序不要求，最多 concurrency 个并发。
 */
async function pMapSettled<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, idx: number) => Promise<R>,
): Promise<Array<{ status: "fulfilled"; value: R } | { status: "rejected"; reason: unknown }>> {
  const n = Math.max(1, Math.min(concurrency, items.length));
  const results: Array<{ status: "fulfilled"; value: R } | { status: "rejected"; reason: unknown }> =
    new Array(items.length);
  if (items.length === 0) return results;
  let cursor = 0;
  const workers = Array.from({ length: n }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        results[i] = { status: "fulfilled", value: await fn(items[i], i) };
      } catch (err) {
        results[i] = { status: "rejected", reason: err };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * 主入口：读文件 → 解析 RunSQL 块 → 拉结果 → 生成新 markdown → Save Dialog 写出。
 */
export async function exportNoteToMarkdown(
  opts: ExportNoteOpts,
): Promise<ExportNoteResult> {
  const { filePath, rowCap } = opts;

  const readFile = opts.deps?.readFile ?? ((p) => window.stela.vault.readFile(p));
  const saveMarkdown =
    opts.deps?.saveMarkdown ??
    ((name, content, saveOpts) =>
      window.stela.export.saveMarkdown(name, content, saveOpts));
  const loaderDeps: ResultLoaderDeps = opts.deps?.loaderDeps ?? {
    storage: {
      getSchema: electronStorage.getSchema,
      queryPage: electronStorage.queryPage,
    },
    journal: {
      importRun: (id) => window.stela.journal.importRun(id),
    },
  };

  const runScope: ExportRunScope = opts.runScope ?? { kind: "latest" };
  const includeDiffSummary = opts.includeDiffSummary ?? false;
  const labels = opts.labels ?? DEFAULT_EXPORT_MARKDOWN_LABELS;
  const listRunsByBlockId =
    opts.deps?.listRunsByBlockId ??
    ((blockId) => electronStorage.listRunsByBlockId(blockId, { limit: EXPORT_MAX_ALL_RUNS, status: "ok" }));

  const md = await readFile(filePath);
  const blocks = parseRunsqlBlocks(md);

  // 没有 RunSQL 块 → 直接导出原文（仅改写 fence 语言标签）
  if (blocks.length === 0) {
    const result = await saveMarkdown(
      suggestExportName(filePath),
      finalizeExportMarkdown(md),
      { title: opts.saveDialogTitle },
    );
    return {
      canceled: result.canceled,
      savedPath: result.path,
      revealToken: result.revealToken ?? null,
      failedBlocks: 0,
    };
  }

  // 每个 block 产出替换片段；并发上限 4
  const built = await pMapSettled<RunsqlBlockInfo, { replacement: string; failed: boolean }>(
    blocks,
    4,
    (block) =>
      buildBlockReplacement(block, {
        rowCap,
        runScope,
        includeDiffSummary,
        labels,
        loaderDeps,
        listRunsByBlockId,
      }),
  );

  // 从后往前替换，确保偏移量不因前面的替换失效
  let output = md;
  let failedBlocks = 0;
  for (let i = built.length - 1; i >= 0; i--) {
    const r = built[i];
    const block = blocks[i];
    let replacement: string;
    if (r.status === "rejected") {
      failedBlocks++;
      replacement = [
        labels.missingData(block.detail.resultRefId ?? "unknown"),
        "",
        block.detailRaw,
      ].join("\n");
    } else {
      if (r.value.failed) failedBlocks++;
      replacement = r.value.replacement;
    }
    output =
      output.slice(0, block.detailStart) +
      replacement +
      output.slice(block.detailEnd);
  }

  const result = await saveMarkdown(
    suggestExportName(filePath),
    finalizeExportMarkdown(output),
    { title: opts.saveDialogTitle },
  );
  return {
    canceled: result.canceled,
    savedPath: result.path,
    revealToken: result.revealToken ?? null,
    failedBlocks,
  };
}

interface BuildBlockDeps {
  rowCap: ExportRowCap;
  runScope: ExportRunScope;
  includeDiffSummary: boolean;
  labels: ExportMarkdownLabels;
  loaderDeps: ResultLoaderDeps;
  listRunsByBlockId: (blockId: string) => Promise<RunRecord[]>;
}

/** 拉取单个 run 的 schema + 行（capN=null 时分页拉全量）。 */
async function fetchRunRows(
  runId: string,
  rowCountHint: number | null,
  rowCap: ExportRowCap,
  loaderDeps: ResultLoaderDeps,
): Promise<{ columns: ColumnDef[]; rows: unknown[][]; total: number }> {
  if (rowCap === null) {
    const firstPage = await loadResultPage(
      { runId, detailRowCount: rowCountHint, pageIndex: 0, pageSize: EXPORT_BATCH_SIZE },
      loaderDeps,
    );
    const allRows: unknown[][] = [...firstPage.rows];
    for (
      let offset = EXPORT_BATCH_SIZE;
      offset < firstPage.total;
      offset += EXPORT_BATCH_SIZE
    ) {
      const page = await loaderDeps.storage.queryPage(runId, offset, EXPORT_BATCH_SIZE);
      allRows.push(...page.rows);
    }
    return { columns: firstPage.schema, rows: allRows, total: firstPage.total };
  }
  const page = await loadResultPage(
    { runId, detailRowCount: rowCountHint, pageIndex: 0, pageSize: rowCap },
    loaderDeps,
  );
  return { columns: page.schema, rows: page.rows, total: page.total };
}

/** 为单个 RunSQL block 构造替换 markdown 片段（按 runScope 决定单/多历史）。 */
async function buildBlockReplacement(
  block: RunsqlBlockInfo,
  deps: BuildBlockDeps,
): Promise<{ replacement: string; failed: boolean }> {
  const {
    rowCap,
    runScope,
    includeDiffSummary,
    labels,
    loaderDeps,
    listRunsByBlockId,
  } = deps;
  const blockId = block.detail.blockId;

  // 仅最新（或缺 blockId 无法查历史）→ 与旧行为完全一致
  if (runScope.kind === "latest" || !blockId) {
    const runId = block.detail.resultRefId;
    if (!runId) {
      return {
        replacement: renderResultBlock(block.detail, [], [], 0, rowCap, labels),
        failed: false,
      };
    }
    try {
      const { columns, rows, total } = await fetchRunRows(
        runId,
        block.detail.rowCount,
        rowCap,
        loaderDeps,
      );
      return {
        replacement: renderResultBlock(
          block.detail,
          columns,
          rows,
          total,
          rowCap,
          labels,
        ),
        failed: false,
      };
    } catch (err) {
      return {
        replacement: [
          labels.missingData(runId),
          "",
          block.detailRaw,
        ].join("\n"),
        failed: true,
      };
    }
  }

  // 多历史：按 blockId 查 run 列表
  let runList: RunRecord[];
  try {
    runList = await listRunsByBlockId(blockId);
  } catch {
    runList = [];
  }
  // 仅成功且有结果集（rowCount>0 视为有结果；mutation rowCount=0 也保留为表头）
  const okRuns = runList.filter((r) => r.status === "ok");
  const limited =
    runScope.kind === "recent" ? okRuns.slice(0, runScope.count) : okRuns.slice(0, EXPORT_MAX_ALL_RUNS);

  // 历史查不到 → 退化为仅最新
  if (limited.length === 0) {
    const runId = block.detail.resultRefId;
    if (!runId) {
      return {
        replacement: renderResultBlock(block.detail, [], [], 0, rowCap, labels),
        failed: false,
      };
    }
    try {
      const { columns, rows, total } = await fetchRunRows(
        runId,
        block.detail.rowCount,
        rowCap,
        loaderDeps,
      );
      return {
        replacement: renderResultBlock(
          block.detail,
          columns,
          rows,
          total,
          rowCap,
          labels,
        ),
        failed: false,
      };
    } catch {
      return {
        replacement: [labels.missingData(runId), "", block.detailRaw].join("\n"),
        failed: true,
      };
    }
  }

  const fetched: FetchedRun[] = await Promise.all(
    limited.map(async (run) => {
      try {
        const { columns, rows, total } = await fetchRunRows(
          run.runId,
          run.rowCount,
          rowCap,
          loaderDeps,
        );
        return { run, columns, rows, total, failed: false };
      } catch (err) {
        return {
          run,
          columns: [],
          rows: [],
          total: 0,
          failed: true,
          failReason: errMessage(err),
        };
      }
    }),
  );

  const parts: string[] = [renderMultiRunResultBlock(fetched, rowCap, labels)];
  if (includeDiffSummary && fetched.length >= 2) {
    const summary = renderDiffSummaryBlock(fetched[0], fetched[1], labels);
    if (summary) {
      parts.push("");
      parts.push(summary);
    }
  }
  const anyFailed = fetched.some((f) => f.failed);
  return { replacement: parts.join("\n"), failed: anyFailed };
}

function errMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return String(err);
}
