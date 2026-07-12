/**
 * Vault index（v0.3 双链 M2）。
 *
 * 主进程内存索引：vault 切换时全扫一遍 `.md`，记下每个文件的
 *   - title       从 frontmatter `title:` 取，无则 fallback 第一段 `# heading`，再无则 basename
 *   - headings    `## H` 等行级 heading 的纯文本与级别
 *   - outgoing    [[target]] / [[target|alias]] 命中
 *   - mtimeMs     用来检测 watcher 增量是否真的需要重解析
 *
 * 倒排表 `Map<targetRel, Set<sourceRel>>`：[[target]] 解析为 vault 根相对路径
 * 后塞进倒排，供 backlinks（M3）查询使用。
 *
 * 增量更新：通过 [./vault-watcher.ts](./vault-watcher.ts) 的 `subscribe()` 接收
 * external change batch，对受影响的 `.md` 重新解析；删除事件清条目。
 *
 * 不进 SQLite：索引是纯派生数据，启动重扫成本可接受（典型 vault < 1000 笔记，
 * 实测百毫秒级）；`.stela.sqlite` 同步 / GC 不该牵涉它。
 *
 * 也不广播详细 diff：renderer 只关心"索引变了，请刷新 UI"，所以单一
 * `INDEX_CHANGED` 事件 + 节流即可，不打一份增量列表过去。
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import type {
  IndexBacklinkEntry,
  IndexCandidate,
  IndexEntrySummary,
} from "@shared/types";
import { IPC_EVENTS } from "@shared/ipc-events";

import { getLogger } from "./logger";
import * as vaultWatcher from "./vault-watcher";

const log = getLogger("vault-index");

const STELA_EXTS = new Set([".md"]);
/** 单文件大小上限：> 4MB 的 markdown 视为离群点，跳过解析（避免日志全文被吃下来） */
const MAX_FILE_BYTES = 4 * 1024 * 1024;
/** INDEX_CHANGED 广播节流：增量更新短时间内的多次解析合并成一次广播 */
const BROADCAST_DEBOUNCE_MS = 250;

/** 与 [src/editor/wiki/remark-wiki-link.ts](../../src/editor/wiki/remark-wiki-link.ts) 同款 */
const WIKI_RE = /\[\[([^\[\]\|\r\n]+?)(?:\|([^\[\]\r\n]+?))?\]\]/g;
/** Frontmatter 边界 */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

interface IndexEntry {
  /** 绝对路径 */
  path: string;
  /** vault 根相对路径（POSIX 形式，无前导 /） */
  relPath: string;
  title: string;
  headings: { id: string; text: string; level: number }[];
  outgoing: { target: string; alias: string | null; line: number; col: number }[];
  mtimeMs: number;
  /** 原始 body（去 frontmatter）—— M3 backlinks snippet 抽取需要，先存着；
   * 大文件已经 size guard 过，常见 vault 内存压力不显著（< 50MB / 1000 笔记） */
  body: string;
}

interface Runtime {
  vaultPath: string;
  /** key: relPath（POSIX，去前缀 /） */
  entries: Map<string, IndexEntry>;
  /** key: 解析后的 relPath（候选优先序：.md > 精确）；value: 引用源 relPath 集合 */
  inverted: Map<string, Set<string>>;
  unsubscribe: () => void;
  broadcastTimer: ReturnType<typeof setTimeout> | null;
  /** 首次全扫 promise；listCandidates / getBacklinks 在它完成前 await。 */
  scanReady: Promise<void>;
}

let runtime: Runtime | null = null;

let broadcaster: ((channel: string) => void) | null = null;

/** main/index.ts 启动时注入；与 vault-watcher 的 setBroadcaster 平行（不复用，
 * 因为 watcher payload 复杂，index 这里只需 fire-and-forget 通知 renderer 失效） */
export function setBroadcaster(fn: (channel: string) => void): void {
  broadcaster = fn;
}

/** 把绝对路径转 POSIX-style relative key。Windows 反斜杠归一化为 /。 */
function toRelKey(absPath: string, vaultPath: string): string | null {
  const rel = path.relative(vaultPath, absPath).replace(/\\/g, "/");
  if (!rel || rel.startsWith("..")) return null;
  return rel;
}

function relPathWithoutExt(rel: string): string {
  const i = rel.lastIndexOf(".");
  if (i <= 0) return rel;
  return rel.slice(0, i);
}

/** 把分段路径里的 `.` / `..` 折叠掉。越界（爬出 vault）返回 null。 */
function normalizeSegments(segs: string[]): string[] | null {
  const out: string[] = [];
  for (const s of segs) {
    if (!s || s === ".") continue;
    if (s === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(s);
  }
  return out;
}

/**
 * 解析一条 wiki target 字符串到 vault 根相对路径段。
 *
 * - `[[foo]]` / `[[/foo]]` → vault 根
 * - `[[./foo]]` / `[[../foo]]` → 相对 `sourceRel` 所在目录（必须给）
 *
 * 越界 / 输入为空 → null。返回归一化后的 segments（不含扩展名扩展，调用方再补）。
 */
function resolveTargetSegments(
  target: string,
  sourceRel: string | null,
): string[] | null {
  // 先剥掉 #anchor —— 倒排只需"路径段"对齐，anchor 是渲染端职责
  const hashIdx = target.indexOf("#");
  const pathPart = hashIdx >= 0 ? target.slice(0, hashIdx) : target;
  const cleaned = pathPart.trim().replace(/\\/g, "/");
  if (!cleaned) return null;

  let baseSegs: string[];
  let relSource: string;
  if (/^\.\.?\//.test(cleaned) || cleaned === "." || cleaned === "..") {
    if (!sourceRel) return null; // 没有 base 时无法解相对路径
    const i = sourceRel.lastIndexOf("/");
    baseSegs = i >= 0 ? sourceRel.slice(0, i).split("/").filter(Boolean) : [];
    relSource = cleaned;
  } else {
    baseSegs = [];
    relSource = cleaned.replace(/^\/+/, "");
  }
  if (!relSource) return null;

  const combined = normalizeSegments([
    ...baseSegs,
    ...relSource.split("/"),
  ]);
  if (!combined || combined.length === 0) return null;
  return combined;
}

/** target 字符串 → 候选 relPath（按 .md / 精确顺序）。 */
function buildCandidateRelKeys(
  target: string,
  sourceRel: string | null = null,
): string[] {
  const segs = resolveTargetSegments(target, sourceRel);
  if (!segs) return [];
  const stripped = segs.join("/");
  if (/\.md$/i.test(stripped)) return [stripped];
  return [`${stripped}.md`, stripped];
}

/**
 * 倒排表用的"归一化 key"。**关键**：必须存查两边都走同一函数，否则会出现
 * "存入和查询 key 不一致"导致空查的情况。
 *
 * 策略：去扩展名（无论源 target 有没有写 .md，都折叠成无扩展形式）。
 * 这样 `[[foo]]`、`[[foo.md]]`、查询 `foo` 都落在同一桶里。
 */
function targetToInvertedKey(
  target: string,
  sourceRel: string | null = null,
): string | null {
  const segs = resolveTargetSegments(target, sourceRel);
  if (!segs) return null;
  const joined = segs.join("/");
  return joined.replace(/\.md$/i, "");
}

/**
 * 异步遍历 vault 内 markdown 文件，复用 search.ts 的过滤规则。
 */
async function* walkMarkdown(root: string): AsyncGenerator<string> {
  const stack: Array<{ dir: string; depth: number }> = [
    { dir: root, depth: 0 },
  ];
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
      if (
        name === "node_modules" ||
        name === "target" ||
        name === "dist" ||
        name === "build" ||
        name === "__pycache__"
      ) {
        continue;
      }
      const full = path.join(dir, name);
      if (ent.isDirectory()) {
        stack.push({ dir: full, depth: depth + 1 });
      } else if (ent.isFile()) {
        const ext = path.extname(name).toLowerCase();
        if (STELA_EXTS.has(ext)) yield full;
      }
    }
  }
}

/**
 * 把 markdown 文本拆 frontmatter / body。返回 frontmatter 原文（不含 fence）与
 * body。frontmatter 可能为空。
 */
function splitFrontmatter(text: string): { fm: string; body: string } {
  const m = FRONTMATTER_RE.exec(text);
  if (!m) return { fm: "", body: text };
  return { fm: m[1], body: text.slice(m[0].length) };
}

/**
 * 简易 frontmatter title 提取：找第一个 `title: ...`。引号 / 多行 / YAML list
 * 都不深究——v0.3 M2 只要"找到大多数情况下的 title"。
 */
function extractFrontmatterTitle(fm: string): string | null {
  if (!fm) return null;
  for (const raw of fm.split(/\r?\n/)) {
    const line = raw.trimStart();
    if (!line || line.startsWith("#")) continue;
    const match = /^title\s*:\s*(.+)$/i.exec(line);
    if (match) {
      let v = match[1].trim();
      // 去掉两端的成对引号（"..." 或 '...'）
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1);
      }
      return v.length > 0 ? v : null;
    }
    // 其它键忽略
  }
  return null;
}

/**
 * 在 body 中按行扫 ATX heading；跳过围栏代码内的伪 heading。返回顺序排列的 heading 列表。
 *
 * heading id：把 text 转 lowercase，空白合并为 `-`，去掉非 [a-z0-9-_] 字符。
 */
/**
 * Heading slug。**必须**和 [src/editor/heading-anchor/slug.ts](../../src/editor/heading-anchor/slug.ts)
 * 的 `slugify` / `buildSlugs` 完全一致——否则 wiki link 的 `[[file#anchor]]`
 * 解析出来的 slug 与 reveal effect 用的 `data-heading-slug` 对不上，跳转就会
 * 跳到文件开头。改这里也要改那边。
 */
const STRIP_PUNCT_RE = /[!@#$%^&*()+=\[\]{}\\|<>?,.:;'"`~/]/g;
function slugify(text: string): string {
  const base = text
    .toLowerCase()
    .replace(STRIP_PUNCT_RE, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "section";
}

function extractHeadings(
  body: string,
): { id: string; text: string; level: number }[] {
  const out: { id: string; text: string; level: number }[] = [];
  let inFence = false;
  let fenceMarker = "";
  const counts = new Map<string, number>();
  for (const raw of body.split(/\r?\n/)) {
    const trimmed = raw.trimStart();
    if (!inFence && (trimmed.startsWith("```") || trimmed.startsWith("~~~"))) {
      inFence = true;
      fenceMarker = trimmed.startsWith("```") ? "```" : "~~~";
      continue;
    }
    if (inFence) {
      if (trimmed.startsWith(fenceMarker)) {
        inFence = false;
        fenceMarker = "";
      }
      continue;
    }
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(trimmed);
    if (!m) continue;
    const level = m[1].length;
    const text = m[2].trim();
    if (!text) continue;
    const base = slugify(text);
    const seen = counts.get(base) ?? 0;
    const id = seen === 0 ? base : `${base}-${seen}`;
    counts.set(base, seen + 1);
    out.push({ id, text, level });
  }
  return out;
}

/**
 * 在 body 中扫 [[...]] 出现位置，跳过围栏代码块；inline code（单 ` 包裹）也跳过。
 */
function extractWikiOutgoing(
  body: string,
): { target: string; alias: string | null; line: number; col: number }[] {
  const out: { target: string; alias: string | null; line: number; col: number }[] =
    [];
  const lines = body.split(/\r?\n/);
  let inFence = false;
  let fenceMarker = "";
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const trimmed = raw.trimStart();
    if (!inFence && (trimmed.startsWith("```") || trimmed.startsWith("~~~"))) {
      inFence = true;
      fenceMarker = trimmed.startsWith("```") ? "```" : "~~~";
      continue;
    }
    if (inFence) {
      if (trimmed.startsWith(fenceMarker)) {
        inFence = false;
        fenceMarker = "";
      }
      continue;
    }
    // 单行 inline code 简单跳过：去掉成对的 `...`
    const stripped = raw.replace(/`[^`\r\n]*`/g, "");
    WIKI_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = WIKI_RE.exec(stripped)) !== null) {
      const target = (m[1] ?? "").trim();
      if (!target) continue;
      const alias = m[2] ? m[2].trim() : null;
      out.push({
        target,
        alias: alias && alias.length > 0 ? alias : null,
        line: i + 1,
        col: m.index + 1,
      });
    }
  }
  return out;
}

function basenameNoExt(rel: string): string {
  const base = path.basename(rel);
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(0, i) : base;
}

async function parseFile(
  absPath: string,
  vaultPath: string,
): Promise<IndexEntry | null> {
  let stat;
  try {
    stat = await fs.stat(absPath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  if (stat.size > MAX_FILE_BYTES) return null;
  const relPath = toRelKey(absPath, vaultPath);
  if (!relPath) return null;
  let content: string;
  try {
    content = await fs.readFile(absPath, "utf-8");
  } catch {
    return null;
  }
  const { fm, body } = splitFrontmatter(content);
  const fmTitle = extractFrontmatterTitle(fm);
  const headings = extractHeadings(body);
  const firstH1 = headings.find((h) => h.level === 1);
  const title = fmTitle ?? firstH1?.text ?? basenameNoExt(relPath);
  const outgoing = extractWikiOutgoing(body);
  return {
    path: absPath,
    relPath,
    title,
    headings,
    outgoing,
    mtimeMs: stat.mtimeMs,
    body,
  };
}

/** 把一份 entry 应用到 runtime（含倒排维护）。返回 true 表示真的有变更。 */
function applyEntry(rt: Runtime, entry: IndexEntry): boolean {
  const prev = rt.entries.get(entry.relPath);
  if (
    prev &&
    prev.mtimeMs === entry.mtimeMs &&
    prev.title === entry.title &&
    prev.outgoing.length === entry.outgoing.length
  ) {
    // 粗判：mtime + outgoing count 一致基本不会改 backlinks；
    // 真有罕见情况漏算，下次 watcher 事件还会再来。
    return false;
  }
  if (prev) removeFromInverted(rt, prev);
  rt.entries.set(entry.relPath, entry);
  addToInverted(rt, entry);
  return true;
}

function addToInverted(rt: Runtime, entry: IndexEntry): void {
  for (const link of entry.outgoing) {
    const key = targetToInvertedKey(link.target, entry.relPath);
    if (!key) continue;
    let set = rt.inverted.get(key);
    if (!set) {
      set = new Set();
      rt.inverted.set(key, set);
    }
    set.add(entry.relPath);
  }
}

function removeFromInverted(rt: Runtime, entry: IndexEntry): void {
  for (const link of entry.outgoing) {
    const key = targetToInvertedKey(link.target, entry.relPath);
    if (!key) continue;
    const set = rt.inverted.get(key);
    if (!set) continue;
    set.delete(entry.relPath);
    if (set.size === 0) rt.inverted.delete(key);
  }
}

function dropEntry(rt: Runtime, relPath: string): boolean {
  const prev = rt.entries.get(relPath);
  if (!prev) return false;
  removeFromInverted(rt, prev);
  rt.entries.delete(relPath);
  return true;
}

function scheduleBroadcast(rt: Runtime): void {
  if (rt.broadcastTimer) return;
  rt.broadcastTimer = setTimeout(() => {
    rt.broadcastTimer = null;
    if (!broadcaster) return;
    try {
      broadcaster(IPC_EVENTS.INDEX_CHANGED);
    } catch (err) {
      log.warn("INDEX_CHANGED broadcast failed", {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }, BROADCAST_DEBOUNCE_MS);
}

async function fullScan(rt: Runtime): Promise<void> {
  const start = Date.now();
  let count = 0;
  for await (const file of walkMarkdown(rt.vaultPath)) {
    const entry = await parseFile(file, rt.vaultPath);
    if (entry) {
      rt.entries.set(entry.relPath, entry);
      addToInverted(rt, entry);
      count += 1;
    }
  }
  log.info("vault-index full scan done", {
    vaultPath: rt.vaultPath,
    files: count,
    elapsedMs: Date.now() - start,
  });
}

async function handleWatchBatch(
  rt: Runtime,
  events: Array<{ type: string; path: string; isDir: boolean }>,
): Promise<void> {
  let changed = false;
  for (const ev of events) {
    if (ev.isDir) continue;
    const ext = path.extname(ev.path).toLowerCase();
    if (!STELA_EXTS.has(ext)) continue;
    const rel = toRelKey(ev.path, rt.vaultPath);
    if (!rel) continue;
    if (ev.type === "removed") {
      if (dropEntry(rt, rel)) changed = true;
      continue;
    }
    // added / changed
    const entry = await parseFile(ev.path, rt.vaultPath);
    if (!entry) {
      // 文件已经又消失或读失败：当作 remove 处理
      if (dropEntry(rt, rel)) changed = true;
      continue;
    }
    if (applyEntry(rt, entry)) changed = true;
  }
  if (changed) scheduleBroadcast(rt);
}

/* ----------------------------------------------------------------------------
 * 公共 API（被 handlers.ts 调用）
 * -------------------------------------------------------------------------- */

export async function start(vaultPath: string | null): Promise<void> {
  await stop();
  if (!vaultPath) return;
  const rt: Runtime = {
    vaultPath,
    entries: new Map(),
    inverted: new Map(),
    unsubscribe: () => {},
    broadcastTimer: null,
    scanReady: Promise.resolve(),
  };
  // 订阅 watcher 的 main-internal 事件流
  rt.unsubscribe = vaultWatcher.subscribe((payload) => {
    if (!runtime || runtime.vaultPath !== payload.vaultPath) return;
    void handleWatchBatch(runtime, payload.events);
  });
  rt.scanReady = fullScan(rt).then(
    () => {
      scheduleBroadcast(rt);
    },
    (err: unknown) => {
      log.error("vault-index full scan failed", {
        vaultPath,
        err: err instanceof Error ? err.message : String(err),
      });
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
    rt.unsubscribe();
  } catch {
    /* noop */
  }
  rt.entries.clear();
  rt.inverted.clear();
}

/**
 * 自动补全候选。query 为空字符串时返回最近修改的若干文件 title。
 * `kind`：renderer 端可视化用，标识"文件 / heading / blockId"——v0.3.0
 * 暂时只产出 file 与 heading；blockId 等 RunSQL detail 整合后再加。
 */
export async function listCandidates(args: {
  query: string;
  limit?: number;
}): Promise<IndexCandidate[]> {
  if (!runtime) return [];
  await runtime.scanReady;
  const limit = Math.max(1, Math.min(args.limit ?? 30, 200));
  const q = args.query.trim().toLowerCase();
  const out: IndexCandidate[] = [];

  for (const entry of runtime.entries.values()) {
    if (out.length >= limit * 4) break;
    const titleScore = scoreMatch(entry.title.toLowerCase(), q);
    const pathScore = scoreMatch(entry.relPath.toLowerCase(), q);
    const score = Math.max(titleScore, pathScore);
    if (q && score < 0) continue;
    out.push({
      kind: "file",
      target: relPathWithoutExt(entry.relPath),
      label: entry.title,
      detail: entry.relPath,
      score: q ? score : entry.mtimeMs,
    });
  }

  if (q) {
    for (const entry of runtime.entries.values()) {
      for (const h of entry.headings) {
        const sc = scoreMatch(h.text.toLowerCase(), q);
        if (sc < 0) continue;
        out.push({
          kind: "heading",
          target: `${relPathWithoutExt(entry.relPath)}#${h.id}`,
          label: h.text,
          detail: `${entry.title} · H${h.level}`,
          score: sc,
        });
        if (out.length >= limit * 4) break;
      }
      if (out.length >= limit * 4) break;
    }
  }

  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}

/**
 * 简易模糊评分。`q` 为空返回 0。命中越靠前 / 越完整分越高；不命中返回 -1。
 */
function scoreMatch(hay: string, q: string): number {
  if (!q) return 0;
  const idx = hay.indexOf(q);
  if (idx < 0) return -1;
  // 起始位置 0 加 100；越靠后衰减；完整长度加分鼓励短匹配
  return 100 - idx + Math.max(0, 30 - hay.length);
}

/**
 * 给定 target relPath（带或不带扩展名都接受），返回引用它的 source 列表。
 *
 * 候选优先级：精确 relPath > basename 自动补 .md（保持与 resolver 一致）。
 */
export async function getBacklinks(args: {
  target: string;
}): Promise<IndexBacklinkEntry[]> {
  if (!runtime) return [];
  await runtime.scanReady;
  // 调用方（AppDockBar BacklinkStatus）传过来的 target 是 vault 根相对、已去扩展名形式；
  // 这里再走一次 targetToInvertedKey 与 addToInverted 用的归一化 key 完全对齐。
  const lookup = targetToInvertedKey(args.target);
  if (!lookup) return [];
  const sources = runtime.inverted.get(lookup);
  if (!sources || sources.size === 0) return [];

  const out: IndexBacklinkEntry[] = [];
  for (const sourceRel of sources) {
    const entry = runtime.entries.get(sourceRel);
    if (!entry) continue;
    // 找出所有指向 target 的 outgoing；每个 link 抽一段 snippet
    for (const link of entry.outgoing) {
      const linkKey = targetToInvertedKey(link.target, entry.relPath);
      if (linkKey !== lookup) continue;
      out.push({
        sourcePath: entry.path,
        sourceTitle: entry.title,
        line: link.line,
        column: link.col,
        snippet: snippetForLink(entry.body, link.line, link.col),
      });
    }
  }
  out.sort((a, b) => {
    if (a.sourceTitle === b.sourceTitle) return a.line - b.line;
    return a.sourceTitle.localeCompare(b.sourceTitle);
  });
  return out;
}

/** 行号 1-based + col 1-based → 取该行前后各 ~80 字。 */
function snippetForLink(body: string, line: number, col: number): string {
  const lines = body.split(/\r?\n/);
  const target = lines[line - 1] ?? "";
  const radius = 80;
  const startCol = Math.max(0, col - 1 - radius);
  const endCol = Math.min(target.length, col - 1 + radius);
  let s = "";
  if (startCol > 0) s += "…";
  s += target.slice(startCol, endCol);
  if (endCol < target.length) s += "…";
  return s;
}

export async function getEntry(args: {
  path: string;
}): Promise<IndexEntrySummary | null> {
  if (!runtime) return null;
  await runtime.scanReady;
  const rel = toRelKey(args.path, runtime.vaultPath);
  if (!rel) return null;
  const entry = runtime.entries.get(rel);
  if (!entry) return null;
  return {
    path: entry.path,
    relPath: entry.relPath,
    title: entry.title,
    headings: entry.headings,
    outgoingCount: entry.outgoing.length,
  };
}
