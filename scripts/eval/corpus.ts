/**
 * 检索评测的语料扫描与机械标注生成。
 *
 * 设计要点：
 *   - 不启动 `electron/services/sql-index.ts`（它要拉 chokidar watcher /
 *     connections-store / connector registry / device-profile）。这里只复用
 *     `parseRunsqlFences` + `extractSqlFacts` 这两个纯 shared 函数做一次性扫描，
 *     得到的表事实与 sql-index 同源。
 *   - 标注全部机械派生，无 LLM、无人工：
 *       M1  表标识符 → 笔记      gold 来自 AST 事实，零泄漏，测「多篇竞争下的排名」
 *       M2  中文 heading → 表    gold 来自该小节 runsql 块实际读写的表；heading 文本
 *                                不在表名 / DDL 里，无直接泄漏
 *       M3  负例                 vault 中确实不存在的词，测虚假高分
 *   - 铁律：凡是用来产生 gold 的信号，禁止进入 ranker。M1/M2 的 gold 只来自
 *     「笔记正文里的 runsql AST 事实」，不来自执行历史，因此 A4 的 frecency
 *     排名不构成自我打分。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { splitFrontmatter } from "@shared/frontmatter";
import { parseRunsqlFences } from "@shared/runsql-fences";
import { extractSqlFacts } from "@shared/sql-facts";

/** 与 search.ts / sql-index.ts 的过滤规则保持一致。 */
const SKIPPED_DIRS = new Set([
  "node_modules",
  "target",
  "dist",
  "build",
  "__pycache__",
]);
const MAX_FILE_BYTES = 4 * 1024 * 1024;

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

export interface HeadingInfo {
  level: number;
  text: string;
  /** heading 行起始字符偏移 */
  start: number;
  /** 小节结束偏移（下一个同级或更高级 heading 之前） */
  sectionEnd: number;
}

export interface BlockInfo {
  noteRel: string;
  blockIndex: number;
  sql: string;
  codeStart: number;
  /** 裸表名（小写），与 sql-index 的 table interner 口径一致 */
  readTables: string[];
  writeTables: string[];
}

export interface NoteInfo {
  rel: string;
  abs: string;
  title: string;
  bytes: number;
  headings: HeadingInfo[];
  /** 去掉 frontmatter 后的正文，用于负例存在性校验 */
  body: string;
}

export interface Corpus {
  vaultPath: string;
  notes: NoteInfo[];
  blocks: BlockInfo[];
  /** 裸表名 → 出现过该表的笔记相对路径集合 */
  tableToNotes: Map<string, Set<string>>;
}

export function resolveVaultPath(): string {
  const fromEnv = process.env.STELA_EVAL_VAULT?.trim();
  if (!fromEnv) {
    throw new Error(
      "STELA_EVAL_VAULT is not set. Point it at a vault directory, e.g.\n" +
        "  STELA_EVAL_VAULT=~/some-vault npm run eval:retrieval",
    );
  }
  return path.resolve(fromEnv.replace(/^~(?=$|\/)/, process.env.HOME ?? "~"));
}

async function* walkMarkdown(root: string): AsyncGenerator<string> {
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (stack.length > 0) {
    const top = stack.pop();
    if (!top) break;
    let entries;
    try {
      entries = await fs.readdir(top.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (top.depth > 0 && ent.name.startsWith(".")) continue;
      if (SKIPPED_DIRS.has(ent.name)) continue;
      const full = path.join(top.dir, ent.name);
      if (ent.isDirectory()) {
        stack.push({ dir: full, depth: top.depth + 1 });
      } else if (ent.isFile() && ent.name.toLowerCase().endsWith(".md")) {
        yield full;
      }
    }
  }
}

function parseHeadings(body: string): HeadingInfo[] {
  const found: Array<{ level: number; text: string; start: number }> = [];
  let offset = 0;
  let inFence = false;
  for (const line of body.split("\n")) {
    const fence = /^(`{3,}|~{3,})/.exec(line);
    if (fence) inFence = !inFence;
    if (!inFence) {
      const m = /^(#{1,6})\s+(.*)$/.exec(line);
      if (m) {
        found.push({
          level: m[1]!.length,
          text: m[2]!.trim(),
          start: offset,
        });
      }
    }
    offset += line.length + 1;
  }

  return found.map((h, i) => {
    let sectionEnd = body.length;
    for (let j = i + 1; j < found.length; j++) {
      if (found[j]!.level <= h.level) {
        sectionEnd = found[j]!.start;
        break;
      }
    }
    return { ...h, sectionEnd };
  });
}

function deriveTitle(rel: string, frontmatter: string, headings: HeadingInfo[]): string {
  const fmTitle = /^title:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim();
  if (fmTitle) return fmTitle.replace(/^["']|["']$/g, "");
  const h1 = headings.find((h) => h.level === 1);
  if (h1) return h1.text;
  return path.basename(rel, ".md");
}

function bareTableNames(refs: Array<{ table: string }>): string[] {
  const out = new Set<string>();
  for (const ref of refs) {
    const name = ref.table.replace(/^[`"[]|[`"\]]$/g, "").trim().toLowerCase();
    if (name) out.add(name);
  }
  return [...out];
}

export async function loadCorpus(vaultPath: string): Promise<Corpus> {
  const notes: NoteInfo[] = [];
  const blocks: BlockInfo[] = [];
  const tableToNotes = new Map<string, Set<string>>();

  for await (const abs of walkMarkdown(vaultPath)) {
    let stat;
    try {
      stat = await fs.stat(abs);
    } catch {
      continue;
    }
    if (stat.size > MAX_FILE_BYTES) continue;
    let raw: string;
    try {
      raw = await fs.readFile(abs, "utf-8");
    } catch {
      continue;
    }
    const rel = path.relative(vaultPath, abs).replace(/\\/g, "/");
    const { frontmatter, body } = splitFrontmatter(raw);
    const headings = parseHeadings(body);
    notes.push({
      rel,
      abs,
      title: deriveTitle(rel, frontmatter, headings),
      bytes: stat.size,
      headings,
      body,
    });

    // fence 偏移基于去掉 frontmatter 的 body，与 headings 同一坐标系。
    for (const fence of parseRunsqlFences(body)) {
      const facts = extractSqlFacts(fence.sql);
      const readTables = bareTableNames(facts.flatMap((f) => f.readTables));
      const writeTables = bareTableNames(facts.flatMap((f) => f.writeTables));
      blocks.push({
        noteRel: rel,
        blockIndex: fence.index,
        sql: fence.sql,
        codeStart: fence.codeStart,
        readTables,
        writeTables,
      });
      for (const table of [...readTables, ...writeTables]) {
        let set = tableToNotes.get(table);
        if (!set) {
          set = new Set();
          tableToNotes.set(table, set);
        }
        set.add(rel);
      }
    }
  }

  notes.sort((a, b) => a.rel.localeCompare(b.rel));
  return { vaultPath, notes, blocks, tableToNotes };
}

// ---------- 标注 ----------

export interface TableToNotesCase {
  query: string;
  goldNotes: string[];
}

export interface HeadingToTablesCase {
  noteRel: string;
  query: string;
  goldTables: string[];
}

export interface Labels {
  vaultPath: string;
  generatedAt: string;
  m1TableToNotes: TableToNotesCase[];
  m2HeadingToTables: HeadingToTablesCase[];
  m3Negatives: string[];
}

/**
 * 表名太短 / 太通用的会退化成噪声查询（`t`、`tmp`、`data`），
 * 且 lezer 偶尔把 CTE alias 或裸标识符当表。用长度与竞争度双重过滤。
 */
const MIN_TABLE_NAME_LENGTH = 6;
const MIN_NOTES_PER_TABLE = 2;
const MAX_M1_CASES = 200;
const MAX_M2_CASES = 200;
const NEGATIVE_COUNT = 30;

export function buildLabels(corpus: Corpus): Labels {
  const m1TableToNotes: TableToNotesCase[] = [];
  for (const [table, noteSet] of corpus.tableToNotes) {
    if (table.length < MIN_TABLE_NAME_LENGTH) continue;
    if (noteSet.size < MIN_NOTES_PER_TABLE) continue;
    m1TableToNotes.push({
      query: table,
      goldNotes: [...noteSet].sort(),
    });
  }
  // 竞争度高的排前面，再按名字定序，保证跨次运行取样一致。
  m1TableToNotes.sort(
    (a, b) => b.goldNotes.length - a.goldNotes.length || a.query.localeCompare(b.query),
  );
  m1TableToNotes.length = Math.min(m1TableToNotes.length, MAX_M1_CASES);

  const blocksByNote = new Map<string, BlockInfo[]>();
  for (const block of corpus.blocks) {
    const list = blocksByNote.get(block.noteRel);
    if (list) list.push(block);
    else blocksByNote.set(block.noteRel, [block]);
  }

  const m2HeadingToTables: HeadingToTablesCase[] = [];
  for (const note of corpus.notes) {
    const noteBlocks = blocksByNote.get(note.rel);
    if (!noteBlocks || noteBlocks.length === 0) continue;
    for (const heading of note.headings) {
      if (!CJK.test(heading.text)) continue;
      const inSection = noteBlocks.filter(
        (b) => b.codeStart >= heading.start && b.codeStart < heading.sectionEnd,
      );
      if (inSection.length === 0) continue;
      const goldTables = [
        ...new Set(inSection.flatMap((b) => [...b.readTables, ...b.writeTables])),
      ].filter((t) => t.length >= MIN_TABLE_NAME_LENGTH);
      if (goldTables.length === 0) continue;
      m2HeadingToTables.push({
        noteRel: note.rel,
        query: heading.text,
        goldTables: goldTables.sort(),
      });
    }
  }
  m2HeadingToTables.sort(
    (a, b) => a.noteRel.localeCompare(b.noteRel) || a.query.localeCompare(b.query),
  );
  m2HeadingToTables.length = Math.min(m2HeadingToTables.length, MAX_M2_CASES);

  return {
    vaultPath: corpus.vaultPath,
    generatedAt: new Date().toISOString(),
    m1TableToNotes,
    m2HeadingToTables,
    m3Negatives: buildNegatives(corpus),
  };
}

/**
 * 负例必须真的不存在，否则测出来的「虚假命中」是真命中。
 * 用确定性候选词 + 全语料存在性校验，不依赖随机。
 */
function buildNegatives(corpus: Corpus): string[] {
  const haystack = corpus.notes.map((n) => n.body.toLowerCase()).join("\n");
  const stems = [
    "qzvx",
    "wkpj",
    "hrmt",
    "ldbq",
    "yfnc",
    "tsgw",
    "bxlk",
    "mpdr",
    "cjvh",
    "zwtq",
  ];
  const suffixes = ["_dataset", "_task_v9", "_summary"];
  const out: string[] = [];
  for (const suffix of suffixes) {
    for (const stem of stems) {
      if (out.length >= NEGATIVE_COUNT) break;
      const candidate = `${stem}${suffix}`;
      if (haystack.includes(candidate)) continue;
      out.push(candidate);
    }
  }
  return out;
}
