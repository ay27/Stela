/**
 * Vault 跨文件搜索。
 *
 * 关键约束：
 * - 行级 substring 匹配，按 **字符**（code-point）维度，不用字节偏移
 *   原因：UTF-8 字符 / 字节单位不同，找位置后切片可能越界 / panic（中文等多字节）
 * - 单文件 > 10MB 跳过
 * - 命中数封顶 max_hits（默认 500）
 * - 跳过隐藏目录 / node_modules / target / dist / build / __pycache__
 *
 * Performance: 大 vault 同步遍历会阻塞 main loop，但 Phase 4 之前先用同步实现；
 * Phase 6 评估改 utilityProcess 异步化。
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { AppError } from "@shared/errors";
import type {
  NoteSearchHit,
  NoteSearchResult,
  SearchHit,
  SearchOptions,
} from "@shared/types";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const SNIPPET_RADIUS = 18;
const DEFAULT_MAX_HITS = 500;

const SKIPPED = new Set([
  "node_modules",
  "target",
  "dist",
  "build",
  "__pycache__",
]);

function shouldSkip(name: string, depth: number): boolean {
  if (depth === 0) return false;
  if (name.startsWith(".")) return true;
  return SKIPPED.has(name);
}

function matchesExt(name: string, exts: string[]): boolean {
  if (exts.length === 0) return true;
  const lower = name.toLowerCase();
  return exts.some((e) => {
    const ext = e.startsWith(".") ? e.slice(1) : e;
    return lower.endsWith("." + ext.toLowerCase());
  });
}

async function* walk(
  root: string,
  exts: string[],
): AsyncGenerator<string> {
  const stack: Array<{ dir: string; depth: number }> = [
    { dir: root, depth: 0 },
  ];
  while (stack.length > 0) {
    const { dir, depth } = stack.pop()!;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (shouldSkip(ent.name, depth + 1)) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        stack.push({ dir: full, depth: depth + 1 });
      } else if (ent.isFile() && matchesExt(ent.name, exts)) {
        yield full;
      }
    }
  }
}

function makeSnippet(chars: string[], col: number, needleLen: number): string {
  const start = Math.max(0, col - SNIPPET_RADIUS);
  const end = Math.min(chars.length, col + needleLen + SNIPPET_RADIUS);
  let s = "";
  if (start > 0) s += "…";
  s += chars.slice(start, end).join("");
  if (end < chars.length) s += "…";
  return s;
}

function findCharOffset(
  hayChars: string[],
  needleChars: string[],
): number {
  if (needleChars.length === 0) return -1;
  if (needleChars.length > hayChars.length) return -1;
  outer: for (let i = 0; i <= hayChars.length - needleChars.length; i++) {
    for (let j = 0; j < needleChars.length; j++) {
      if (hayChars[i + j] !== needleChars[j]) continue outer;
    }
    return i;
  }
  return -1;
}

const STELA_EXTS = [".md"];

export async function searchVault(
  vaultPath: string,
  keyword: string,
  options: SearchOptions = {},
): Promise<SearchHit[]> {
  const cap = options.maxHits ?? DEFAULT_MAX_HITS;
  if (!keyword) return [];

  let stat;
  try {
    stat = await fs.stat(vaultPath);
  } catch {
    throw new AppError("invalid_vault", `not a directory: ${vaultPath}`);
  }
  if (!stat.isDirectory()) {
    throw new AppError("invalid_vault", `not a directory: ${vaultPath}`);
  }

  const caseSensitive = options.caseSensitive ?? false;
  const needleStr = caseSensitive ? keyword : keyword.toLowerCase();
  const needleChars = [...needleStr];
  if (needleChars.length === 0) return [];

  const hits: SearchHit[] = [];
  for await (const file of walk(vaultPath, STELA_EXTS)) {
    let stat2;
    try {
      stat2 = await fs.stat(file);
    } catch {
      continue;
    }
    if (stat2.size > MAX_FILE_BYTES) continue;
    let content: string;
    try {
      content = await fs.readFile(file, "utf-8");
    } catch {
      continue;
    }
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineChars = [...line];
      const hayChars = caseSensitive ? lineChars : [...line.toLowerCase()];
      const col = findCharOffset(hayChars, needleChars);
      if (col < 0) continue;
      const snippetSrc =
        lineChars.length === hayChars.length ? lineChars : hayChars;
      hits.push({
        path: file,
        line: i + 1,
        column: col + 1,
        snippet: makeSnippet(snippetSrc, col, needleChars.length),
      });
      if (hits.length >= cap) return hits;
    }
  }
  return hits;
}

/**
 * 打分权重。意图：标题命中最强（笔记就是在讲这个），小节标题次之，正文行数只做
 * 微弱加成——否则一篇反复提到关键词的散记会盖过真正的主题笔记。
 */
const TITLE_WEIGHT = 40;
const HEADING_WEIGHT = 12;
const MAX_SCORED_HEADINGS = 3;
const BODY_LINE_WEIGHT = 1;
const MAX_SCORED_BODY_LINES = 10;
const DEFAULT_MAX_NOTES = 40;

function noteTitle(rel: string, lines: string[]): string {
  // frontmatter 一定在文件开头，`title:` 直接扫前几行即可，不必解析整块。
  for (let i = 0; i < Math.min(lines.length, 30); i++) {
    const m = /^title:\s*(.+)$/.exec(lines[i] ?? "");
    if (m) return m[1]!.trim().replace(/^["']|["']$/g, "");
  }
  for (const line of lines) {
    const m = /^#\s+(.*)$/.exec(line);
    if (m?.[1]?.trim()) return m[1].trim();
  }
  return path.basename(rel, path.extname(rel));
}

/**
 * 笔记级聚合搜索。相对 {@link searchVault} 的三个区别，都是为了让 agent 在
 * 千篇量级下找得准：
 *   1. **扫完整个 vault 再排序截断**，不再「攒满 cap 就 return」——旧行为等于
 *      按目录遍历顺序切掉后面所有笔记，与相关性无关；
 *   2. 多个关键词在**同一次扫描**里一起算分，按命中的关键词**覆盖数**加权，
 *      取代「把 maxHits 预算平分给每个关键词」——后者会让最相关的笔记
 *      因为别的关键词吃掉预算而落榜；
 *   3. 返回 `totalMatchedNotes / truncated / scannedNotes`，让模型知道自己
 *      是否只看到了一部分。
 *
 * 全扫成本：真实 vault 正文合计 ~6 MB，一次扫描远低于一次 LLM 调用，
 * 所以不引入 FTS5 之类的倒排索引（见 ADR-0026）。
 */
export async function searchVaultNotes(
  vaultPath: string,
  keywords: string[],
  options: { maxNotes?: number; caseSensitive?: boolean } = {},
): Promise<NoteSearchResult> {
  const maxNotes = Math.max(1, options.maxNotes ?? DEFAULT_MAX_NOTES);
  const caseSensitive = options.caseSensitive ?? false;
  const needles = Array.from(
    new Set(
      keywords
        .map((keyword) => keyword.trim())
        .filter(Boolean)
        .map((keyword) => (caseSensitive ? keyword : keyword.toLowerCase())),
    ),
  );
  if (needles.length === 0) {
    return { notes: [], scannedNotes: 0, totalMatchedNotes: 0, returned: 0, truncated: false };
  }

  let stat;
  try {
    stat = await fs.stat(vaultPath);
  } catch {
    throw new AppError("invalid_vault", `not a directory: ${vaultPath}`);
  }
  if (!stat.isDirectory()) {
    throw new AppError("invalid_vault", `not a directory: ${vaultPath}`);
  }

  const matched: NoteSearchHit[] = [];
  let scannedNotes = 0;

  for await (const file of walk(vaultPath, STELA_EXTS)) {
    let fileStat;
    try {
      fileStat = await fs.stat(file);
    } catch {
      continue;
    }
    if (fileStat.size > MAX_FILE_BYTES) continue;
    let content: string;
    try {
      content = await fs.readFile(file, "utf-8");
    } catch {
      continue;
    }
    scannedNotes++;

    const rel = path.relative(vaultPath, file).replace(/\\/g, "/");
    const lines = content.split("\n");
    const title = noteTitle(rel, lines);
    const titleHay = caseSensitive ? title : title.toLowerCase();
    const relHay = caseSensitive ? rel : rel.toLowerCase();

    const bodyLines = new Map<string, number>();
    const headingsFor = new Map<string, Set<string>>();
    const matchedKeywords = new Set<string>();
    let currentHeading = "";
    let bestLine = 0;
    let bestSnippet = "";
    let inFence = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (/^(`{3,}|~{3,})/.test(line)) inFence = !inFence;
      if (!inFence) {
        const heading = /^#{1,6}\s+(.*)$/.exec(line);
        if (heading) currentHeading = heading[1]!.trim();
      }
      const hayChars = [...(caseSensitive ? line : line.toLowerCase())];
      for (const needle of needles) {
        const col = findCharOffset(hayChars, [...needle]);
        if (col < 0) continue;
        matchedKeywords.add(needle);
        bodyLines.set(needle, (bodyLines.get(needle) ?? 0) + 1);
        if (currentHeading) {
          const set = headingsFor.get(needle) ?? new Set<string>();
          set.add(currentHeading);
          headingsFor.set(needle, set);
        }
        if (bestLine === 0) {
          bestLine = i + 1;
          bestSnippet = makeSnippet([...line], col, needle.length);
        }
      }
    }

    // 路径/标题命中也算——`db.table.md` 这类 schema 文档正文里未必再写一遍表名。
    let score = 0;
    const matchedHeadings = new Set<string>();
    for (const needle of needles) {
      const inTitle =
        findCharOffset([...titleHay], [...needle]) >= 0 ||
        findCharOffset([...relHay], [...needle]) >= 0;
      if (inTitle) {
        score += TITLE_WEIGHT;
        matchedKeywords.add(needle);
      }
      const headings = headingsFor.get(needle);
      if (headings) {
        score += HEADING_WEIGHT * Math.min(headings.size, MAX_SCORED_HEADINGS);
        for (const heading of headings) matchedHeadings.add(heading);
      }
      score +=
        BODY_LINE_WEIGHT * Math.min(bodyLines.get(needle) ?? 0, MAX_SCORED_BODY_LINES);
    }
    if (matchedKeywords.size === 0) continue;
    // 覆盖数加权：命中 3 个关键词的笔记应远排在只命中 1 个的前面。
    score *= matchedKeywords.size;

    matched.push({
      path: rel,
      title,
      score,
      matchCount: [...bodyLines.values()].reduce((sum, n) => sum + n, 0),
      matchedKeywords: [...matchedKeywords],
      matchedHeadings: [...matchedHeadings].slice(0, 5),
      bestSnippet,
      bestLine,
    });
  }

  matched.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const notes = matched.slice(0, maxNotes);
  return {
    notes,
    scannedNotes,
    totalMatchedNotes: matched.length,
    returned: notes.length,
    truncated: matched.length > notes.length,
  };
}

export async function listVaultFiles(
  vaultPath: string,
  extensions: string[],
): Promise<string[]> {
  let stat;
  try {
    stat = await fs.stat(vaultPath);
  } catch {
    throw new AppError("invalid_vault", `not a directory: ${vaultPath}`);
  }
  if (!stat.isDirectory()) {
    throw new AppError("invalid_vault", `not a directory: ${vaultPath}`);
  }
  const out: string[] = [];
  for await (const file of walk(vaultPath, extensions)) {
    out.push(file);
  }
  out.sort();
  return out;
}
