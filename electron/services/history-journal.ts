/**
 * 执行历史 Journal（按设备分片 JSONL，Git 同步）。
 *
 * 模型："写隔离、读合并"
 *   - 写：本机只 append 自己的 `.stela/history/history_{slug}.jsonl`，一行一个
 *     完整 run 包（record + columns + rows）。append-only，与"历史不可改"语义一致。
 *   - 读：vault open / git pull 后增量扫描所有 `history_*.jsonl`，按游标续读新行，
 *     `INSERT OR IGNORE` 进本机 SQLite 缓存（runId 去重）。
 *   - SQLite 是查询加速缓存，可随时从 JSONL 全量重建。
 *
 * Git 只同步 Markdown + 这些 JSONL；`.stela.sqlite*` 永不进 git。
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import type {
  DeviceProfile,
  JournalCleanupSummary,
  JournalImportSummary,
  JournalSource,
  RunRecord,
  ColumnDef,
} from "@shared/types";

import { atomicWriteFile } from "./atomic-write";
import { getLogger } from "./logger";
import { vaultConfigDir } from "./vault-paths";
import * as resultStore from "./result-store";
import {
  MAX_INLINE_RESULT_BYTES,
  TRUNCATED_MESSAGE_PREFIX,
} from "@shared/journal-limits";

// 写侧函数需要的设备标识由调用方（handlers，已 import device-profile）注入。
// history-journal 本身**不** import device-profile，从而：
//   1. 不把 electron `app` 依赖带进读侧（import/cursor/dedupe 可在 RUN_AS_NODE 单测）；
//   2. 避免在 main 进程 bundle 里引入动态 import（曾触发 electron-vite CJS-shim 注入错误）。

const log = getLogger("history-journal");

const JOURNAL_LINE_VERSION = 1;
const FILE_PREFIX = "history_";
const FILE_SUFFIX = ".jsonl";

/**
 * 单个 JSONL 文件的字节上限。超过后写侧会把当前活动文件「封存」成带序号的段文件
 * （`history_{slug}.000001.jsonl`），再写一个新的活动文件，避免历史文件无限膨胀、
 * 拖慢 git diff / 全量重建。段文件与活动文件用同样的扫描规则被增量导入。
 */
export const MAX_FILE_BYTES = 64 * 1024 * 1024;

/**
 * 单行 JSONL 的"含 rows"硬上限。超过这个阈值的 run 在 append 时会被**截断**：
 *   - JSONL 行里 `rows: []`、`record.message` 标注 truncated 提示
 *   - 本机 SQLite 通常也已经在 renderer 写侧被同阈值截断（不写 result_rows），
 *     所以 buildJournalLine 这一层是兜底，应对历史已有 run 或绕过 renderer 的情况
 *
 * 阈值与 `@shared/journal-limits.ts` 共享：renderer 与 main 用同一个数字，避免
 * 两侧策略漂移（一侧写下 rows、另一侧又截掉）。
 */
export const MAX_LINE_BYTES = MAX_INLINE_RESULT_BYTES;

// 测试钩子：允许单测用极小阈值验证 rotate，而不必真的写 64MB。仅测试代码调用。
let maxFileBytesOverride: number | null = null;
export function __setMaxFileBytesForTest(n: number | null): void {
  maxFileBytesOverride = n;
}
function maxFileBytes(): number {
  return maxFileBytesOverride ?? MAX_FILE_BYTES;
}

let maxLineBytesOverride: number | null = null;
export function __setMaxLineBytesForTest(n: number | null): void {
  maxLineBytesOverride = n;
}
function maxLineBytes(): number {
  return maxLineBytesOverride ?? MAX_LINE_BYTES;
}

/** 段文件序号宽度（零填充），保证字典序与生成顺序一致。 */
const SEGMENT_DIGITS = 6;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 段文件名：`history_{slug}.{NNNNNN}.jsonl`。 */
function sealedFileName(slug: string, segment: number): string {
  const seg = String(segment).padStart(SEGMENT_DIGITS, "0");
  return `${FILE_PREFIX}${slug}.${seg}${FILE_SUFFIX}`;
}

/** 匹配某 slug 的段文件，捕获序号。 */
function segmentRegex(slug: string): RegExp {
  return new RegExp(
    `^${escapeRegExp(FILE_PREFIX + slug)}\\.(\\d+)${escapeRegExp(FILE_SUFFIX)}$`,
  );
}

interface JournalLine {
  v: number;
  runId: string;
  deviceId: string;
  appendedAt: number;
  record: RunRecord;
  columns: ColumnDef[];
  rows: unknown[][];
}

function historyDir(vaultPath: string): string {
  return path.join(vaultConfigDir(vaultPath), "history");
}

function fileNameForSlug(slug: string): string {
  return `${FILE_PREFIX}${slug}${FILE_SUFFIX}`;
}

function slugFromFileName(fileName: string): string {
  const inner = fileName.slice(FILE_PREFIX.length, -FILE_SUFFIX.length);
  // 段文件 `slug.000001` → 还原成设备 slug，便于 UI 按设备归类展示。
  return inner.replace(/\.\d+$/, "");
}

async function ensureHistoryDir(vaultPath: string): Promise<string> {
  const dir = historyDir(vaultPath);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function listJournalFiles(vaultPath: string): Promise<string[]> {
  const dir = historyDir(vaultPath);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return entries
    .filter((f) => f.startsWith(FILE_PREFIX) && f.endsWith(FILE_SUFFIX))
    .sort();
}

async function fileSize(fp: string): Promise<number> {
  try {
    return (await fs.stat(fp)).size;
  } catch {
    return 0;
  }
}

/** 该 slug 下一个可用段序号（已存在段的最大值 +1）。 */
async function nextSegmentIndex(dir: string, slug: string): Promise<number> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return 1;
  }
  const re = segmentRegex(slug);
  let max = 0;
  for (const name of names) {
    const m = name.match(re);
    if (m) max = Math.max(max, Number.parseInt(m[1], 10));
  }
  return max + 1;
}

/**
 * 封存当前活动文件：rename 成新的段文件。把已导入游标平移到段文件名、活动文件名
 * 游标归零——本机已缓存这些 run，平移游标可避免增量导入把整段重新读一遍。
 */
async function sealActiveFile(dir: string, slug: string): Promise<void> {
  const activeName = fileNameForSlug(slug);
  const activeFp = path.join(dir, activeName);
  const segment = await nextSegmentIndex(dir, slug);
  const sealedName = sealedFileName(slug, segment);
  await fs.rename(activeFp, path.join(dir, sealedName));
  try {
    const carried = resultStore.getJournalCursor(activeName);
    resultStore.setJournalCursor(sealedName, carried);
    resultStore.setJournalCursor(activeName, 0);
  } catch {
    // SQLite 未打开（理论上 append 时已 open）；游标缺失只会导致下次全量重读，无数据风险。
  }
  log.info("sealed journal segment", { sealedName });
}

/**
 * 追加若干 JSONL 行到本设备活动文件，按 64MB 上限自动切分。
 * 单行本身超限时无法切分，会独占一个段（写完即被下一行触发封存）。
 */
async function appendLinesWithRotation(
  dir: string,
  slug: string,
  lines: string[],
): Promise<void> {
  if (lines.length === 0) return;
  const activeFp = path.join(dir, fileNameForSlug(slug));
  const limit = maxFileBytes();
  let projected = await fileSize(activeFp);
  let pending: string[] = [];
  const flush = async () => {
    if (pending.length === 0) return;
    await fs.appendFile(activeFp, pending.join(""), "utf-8");
    pending = [];
  };
  for (const line of lines) {
    const chunk = `${line}\n`;
    const bytes = Buffer.byteLength(chunk, "utf-8");
    if (projected > 0 && projected + bytes > limit) {
      await flush(); // 先把待写行落到旧活动文件，再封存它。
      await sealActiveFile(dir, slug);
      projected = 0;
    }
    pending.push(chunk);
    projected += bytes;
  }
  await flush();
}

/**
 * 序列化一行 JSONL。如果含 rows 的整体字节数超过 `MAX_LINE_BYTES`，会**降级**：
 *   - 丢掉 rows（rows=[]）
 *   - 在 `record.message` 末尾追加 truncated 提示，附原始 rowCount + 行字节数，
 *     方便日后排查 / 在 UI 上提示"该 run 远端无法回填明细"
 *
 * 返回 `{ line, truncated }` 而不仅是字符串——让调用方可以 log / 计数，方便观测。
 */
function buildJournalLine(
  record: RunRecord,
  columns: ColumnDef[],
  rows: unknown[][],
  deviceId: string,
): { line: string; truncated: boolean } {
  const full: JournalLine = {
    v: JOURNAL_LINE_VERSION,
    runId: record.runId,
    deviceId,
    appendedAt: Date.now(),
    record,
    columns,
    rows,
  };
  const serialized = JSON.stringify(full);
  const limit = maxLineBytes();
  if (Buffer.byteLength(serialized, "utf-8") <= limit) {
    return { line: serialized, truncated: false };
  }
  const original = record.message ?? "";
  const note = `${TRUNCATED_MESSAGE_PREFIX} in journal: rowCount=${record.rowCount}, lineBytes=${Buffer.byteLength(serialized, "utf-8")}`;
  const truncatedRecord: RunRecord = {
    ...record,
    message: original ? `${original}\n${note}` : note,
  };
  const truncated: JournalLine = {
    ...full,
    record: truncatedRecord,
    rows: [],
  };
  log.warn("journal line truncated", {
    runId: record.runId,
    rowCount: record.rowCount,
    lineBytes: Buffer.byteLength(serialized, "utf-8"),
    limit,
  });
  return { line: JSON.stringify(truncated), truncated: true };
}

/**
 * 把一个已存在于本机 SQLite 的 run（按 runId 读取）追加到本设备 JSONL。
 * 调用时机：RunSQL 成功并写完 SQLite 之后（由 renderer 经 IPC 触发）。
 */
export async function appendRunById(
  vaultPath: string,
  runId: string,
  profile: DeviceProfile,
): Promise<void> {
  const record = resultStore.getRun(runId);
  if (!record) {
    log.warn("appendRunById: run not found in cache, skip", { runId });
    return;
  }
  const columns = resultStore.getSchema(runId);
  const rows = record.status === "ok" ? resultStore.getAllRows(runId) : [];
  const { line } = buildJournalLine(record, columns, rows, profile.deviceId);
  const dir = await ensureHistoryDir(vaultPath);
  await appendLinesWithRotation(dir, profile.slug, [line]);
}

function parseLine(raw: string): resultStore.RunPackage | null {
  let obj: JournalLine;
  try {
    obj = JSON.parse(raw) as JournalLine;
  } catch {
    return null;
  }
  if (obj.v !== JOURNAL_LINE_VERSION) return null;
  if (!obj.record || typeof obj.record.runId !== "string") return null;
  return {
    record: obj.record,
    columns: Array.isArray(obj.columns) ? obj.columns : [],
    rows: Array.isArray(obj.rows) ? obj.rows : [],
  };
}

interface FileScan {
  /** 已消费到的字节 offset（仅推进到最后一个完整换行） */
  consumedBytes: number;
  linesRead: number;
  imported: number;
  skipped: number;
}

/**
 * 从给定字节 offset 读取一个 JSONL 文件的新增内容，导入完整行。
 * 只推进到最后一个 `\n`，避免读到正在写入的半行。
 */
async function scanFileFrom(
  fp: string,
  startOffset: number,
): Promise<FileScan> {
  const stat = await fs.stat(fp);
  const size = stat.size;
  let offset = startOffset;
  if (offset > size) offset = 0; // 文件被重置 / 缩短 → 从头读
  if (offset >= size) {
    return { consumedBytes: offset, linesRead: 0, imported: 0, skipped: 0 };
  }
  const length = size - offset;
  const buf = Buffer.alloc(length);
  const fh = await fs.open(fp, "r");
  try {
    await fh.read(buf, 0, length, offset);
  } finally {
    await fh.close();
  }
  const lastNl = buf.lastIndexOf(0x0a);
  if (lastNl < 0) {
    // 还没有完整行 → 不推进游标，等下次。
    return { consumedBytes: offset, linesRead: 0, imported: 0, skipped: 0 };
  }
  const usable = buf.subarray(0, lastNl + 1).toString("utf-8");
  let linesRead = 0;
  let imported = 0;
  let skipped = 0;
  for (const rawLine of usable.split("\n")) {
    if (!rawLine.trim()) continue;
    linesRead += 1;
    const pkg = parseLine(rawLine);
    if (!pkg) {
      skipped += 1;
      continue;
    }
    if (resultStore.importRunPackage(pkg)) imported += 1;
  }
  return {
    consumedBytes: offset + Buffer.byteLength(usable, "utf-8"),
    linesRead,
    imported,
    skipped,
  };
}

/** 增量导入：对每个 JSONL 文件从游标续读新行写入缓存。 */
export async function importIncremental(
  vaultPath: string,
): Promise<JournalImportSummary> {
  const startedAt = Date.now();
  const files = await listJournalFiles(vaultPath);
  let linesRead = 0;
  let imported = 0;
  let skipped = 0;
  for (const fileName of files) {
    const fp = path.join(historyDir(vaultPath), fileName);
    const cursor = resultStore.getJournalCursor(fileName);
    try {
      const scan = await scanFileFrom(fp, cursor);
      if (scan.consumedBytes !== cursor) {
        resultStore.setJournalCursor(fileName, scan.consumedBytes);
      }
      linesRead += scan.linesRead;
      imported += scan.imported;
      skipped += scan.skipped;
    } catch (err) {
      log.error("import journal file failed", {
        fileName,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const summary: JournalImportSummary = {
    files: files.length,
    linesRead,
    imported,
    skipped,
    elapsedMs: Date.now() - startedAt,
  };
  if (imported > 0 || skipped > 0) {
    // 日志文案勿以单词 "import" 结尾紧贴引号：electron-vite 的 esm-shim 插件用正则
    // 探测 ESM import 语句，`import"` 会被误判为 `import "..."` 并把 CJS shim 注入到
    // 后续字符串字面量中间，导致 main bundle "Unterminated string literal"。
    log.info("incremental journal import done", summary);
  }
  return summary;
}

/**
 * 按需导入：本机缓存缺某个 runId 时，全量扫描所有 JSONL 找到该 run 并导入。
 * 不依赖游标（缓存可能被清过，目标行在游标之前）。返回是否找到并导入。
 */
export async function importRun(
  vaultPath: string,
  runId: string,
): Promise<boolean> {
  if (resultStore.runExists(runId)) return true;
  const files = await listJournalFiles(vaultPath);
  for (const fileName of files) {
    const fp = path.join(historyDir(vaultPath), fileName);
    let content: string;
    try {
      content = await fs.readFile(fp, "utf-8");
    } catch {
      continue;
    }
    for (const rawLine of content.split("\n")) {
      if (!rawLine.includes(runId)) continue;
      const pkg = parseLine(rawLine);
      if (pkg && pkg.record.runId === runId) {
        return resultStore.importRunPackage(pkg);
      }
    }
  }
  return false;
}

/** 全量重建缓存：清空缓存与游标后重新增量导入全部 JSONL。 */
export async function rebuildCache(
  vaultPath: string,
): Promise<JournalImportSummary> {
  resultStore.clearResultCache();
  return importIncremental(vaultPath);
}

/** 列出所有 JSONL 文件及其导入进度（Settings 展示）。 */
export async function listSources(
  vaultPath: string,
  profile: DeviceProfile,
): Promise<JournalSource[]> {
  const currentFile = fileNameForSlug(profile.slug);
  const files = await listJournalFiles(vaultPath);
  const out: JournalSource[] = [];
  const relBase = path.join(
    path.basename(vaultConfigDir(vaultPath)),
    "history",
  );
  for (const fileName of files) {
    const fp = path.join(historyDir(vaultPath), fileName);
    let sizeBytes = 0;
    try {
      sizeBytes = (await fs.stat(fp)).size;
    } catch {
      /* ignore */
    }
    out.push({
      relPath: `${relBase}/${fileName}`,
      fileName,
      slug: slugFromFileName(fileName),
      isCurrentDevice: fileName === currentFile,
      sizeBytes,
      importedBytes: resultStore.getJournalCursor(fileName),
    });
  }
  return out;
}

/**
 * 一次性迁移：把本机 SQLite 里已有但还没进任何 JSONL 的 run 导出到本设备 JSONL。
 * 用于从旧 COS 同步切换到 Git+JSONL 的用户首次迁移。返回导出的 run 数。
 */
export async function exportExistingRunsToJournal(
  vaultPath: string,
  profile: DeviceProfile,
): Promise<number> {
  const runs = resultStore.listRuns();
  if (runs.length === 0) return 0;
  // 已经在本设备 JSONL（活动文件 + 历史段文件）里的 runId 集合，避免重复导出。
  const dir = await ensureHistoryDir(vaultPath);
  const activeName = fileNameForSlug(profile.slug);
  const segRe = segmentRegex(profile.slug);
  const ownFiles = (await listJournalFiles(vaultPath)).filter(
    (f) => f === activeName || segRe.test(f),
  );
  const existing = new Set<string>();
  for (const fileName of ownFiles) {
    let content: string;
    try {
      content = await fs.readFile(path.join(dir, fileName), "utf-8");
    } catch {
      continue;
    }
    for (const rawLine of content.split("\n")) {
      const pkg = parseLine(rawLine);
      if (pkg) existing.add(pkg.record.runId);
    }
  }
  const lines: string[] = [];
  for (const record of runs) {
    if (existing.has(record.runId)) continue;
    const columns = resultStore.getSchema(record.runId);
    const rows =
      record.status === "ok" ? resultStore.getAllRows(record.runId) : [];
    const { line } = buildJournalLine(record, columns, rows, profile.deviceId);
    lines.push(line);
  }
  // 批量导出同样走 rotation：旧 vault 一次性迁移大量历史时不会写出一个超大文件。
  await appendLinesWithRotation(dir, profile.slug, lines);
  return lines.length;
}

/**
 * 按 startedAt 清理早于 cutoff 的历史。
 *
 * 流程：
 *   1. 列出所有 JSONL（活动文件 + 段文件）。
 *   2. 逐文件按行读、保留 `record.startedAt >= cutoff` 的行：
 *      - 全保留 → 跳过（不重写、不算 filesRewritten）。
 *      - 部分保留 → atomicWriteFile 重写。
 *      - 全部丢弃且是段文件 → 删除；活动文件即使空也写空内容保留（写侧仍会向它 append）。
 *   3. 从 SQLite 删 startedAt < cutoff 的 run（FK 级联清 schemas / rows）。
 *   4. 重置所有 journal 游标——重写后文件 offset 已变，下次 incremental import 从 0
 *      开始重扫存活行，靠 INSERT OR IGNORE 去重，避免读到失效 offset。
 *
 * 设计取舍：
 *   - cutoff 由 caller 计算（一般 = now - keepDays*24h），与 result-store.cleanup
 *     的语义一致；这里只接受绝对时间，便于 UI 显示"清理早于 X 的历史"。
 *   - 半行保护：扫描时遇到不完整尾行（无 \n）直接保留（追加回去），不计入 linesDeleted。
 *   - 解析失败的行（v 不匹配或非 JSON）原样保留，避免误删用户私有数据。
 */
export async function cleanupOlderThan(
  vaultPath: string,
  cutoff: number,
): Promise<JournalCleanupSummary> {
  const startedAt = Date.now();
  const dir = historyDir(vaultPath);
  const files = await listJournalFiles(vaultPath);
  let filesRewritten = 0;
  let filesDeleted = 0;
  let linesDeleted = 0;
  // 活动文件名集合：用 slug 反推不到（同一 slug 的段文件也 share slug），改为
  // 检测"无段号后缀"——`history_{slug}.jsonl` 这种纯活动文件名。
  const isActiveFile = (name: string): boolean =>
    /^history_[^./]+\.jsonl$/.test(name);
  for (const fileName of files) {
    const fp = path.join(dir, fileName);
    let content: string;
    try {
      content = await fs.readFile(fp, "utf-8");
    } catch (err) {
      log.error("cleanup: read failed", {
        fileName,
        err: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    // 拆出"完整行 + 可能的半行"——半行（不以 \n 结尾）原样保留，防止把写侧
    // 正在 append 的最后一行错切。
    const hasTrailingNewline = content.endsWith("\n");
    const lines = content.split("\n");
    const tail = hasTrailingNewline ? "" : (lines.pop() ?? "");
    const kept: string[] = [];
    let removedThisFile = 0;
    for (const raw of lines) {
      if (!raw) {
        // 空行（连续 \n 或末尾换行）——保留行结构，但不计入删除。
        kept.push(raw);
        continue;
      }
      const pkg = parseLine(raw);
      if (!pkg) {
        // 解析失败：保留，避免误删未知格式。
        kept.push(raw);
        continue;
      }
      if (pkg.record.startedAt < cutoff) {
        removedThisFile += 1;
        continue;
      }
      kept.push(raw);
    }
    if (removedThisFile === 0) continue;
    linesDeleted += removedThisFile;
    const newContent = kept.length > 0 ? `${kept.join("\n")}\n${tail}` : tail;
    if (newContent.length === 0 && !isActiveFile(fileName)) {
      // 段文件被完全清空 → 删除
      try {
        await fs.unlink(fp);
        filesDeleted += 1;
      } catch (err) {
        log.error("cleanup: unlink failed", {
          fileName,
          err: err instanceof Error ? err.message : String(err),
        });
      }
      // 段文件被删，对应游标一并清理（与下面的 resetJournalCursors 重复也无害）
      continue;
    }
    try {
      await atomicWriteFile(fp, newContent);
      filesRewritten += 1;
    } catch (err) {
      log.error("cleanup: rewrite failed", {
        fileName,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  let runsDeleted = 0;
  try {
    runsDeleted = resultStore.deleteRunsBefore(cutoff);
    if (filesRewritten > 0 || filesDeleted > 0) {
      // 文件 offset 已变，原游标失效——重置后让下次 import 从 0 开始重扫存活行。
      resultStore.resetJournalCursors();
    }
  } catch (err) {
    log.error("cleanup: sqlite prune failed", {
      err: err instanceof Error ? err.message : String(err),
    });
  }
  const summary: JournalCleanupSummary = {
    cutoff,
    files: files.length,
    filesRewritten,
    filesDeleted,
    linesDeleted,
    runsDeleted,
    elapsedMs: Date.now() - startedAt,
  };
  log.info("journal cleanup done", summary);
  return summary;
}

/** 便捷封装：按"保留最近 N 天"清理。N<=0 时不动文件，直接返回零值。 */
export async function cleanupByKeepDays(
  vaultPath: string,
  keepDays: number,
): Promise<JournalCleanupSummary> {
  if (keepDays <= 0) {
    return {
      cutoff: 0,
      files: 0,
      filesRewritten: 0,
      filesDeleted: 0,
      linesDeleted: 0,
      runsDeleted: 0,
      elapsedMs: 0,
    };
  }
  const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
  return cleanupOlderThan(vaultPath, cutoff);
}
