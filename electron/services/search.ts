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
import type { SearchHit, SearchOptions } from "@shared/types";

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
