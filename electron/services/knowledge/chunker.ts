/**
 * Markdown-aware chunker for the knowledge base.
 *
 * 切片策略（v1，目标：保留 heading / Block 边界，token 近似可控）：
 *
 *   1. 先按 frontmatter 剥出 body（复用 `vault-index` 的同款 splitter，避免 yaml 进入索引噪音）
 *   2. body 沿 markdown heading（# ~ ######）切成"section"，每 section 带 heading slug / text 元信息；
 *      同时跳过 fenced code 区里的伪 heading
 *   3. 对每个 section 的纯文本按段落（空行）二次细分；段落级再按 token 阈值滑窗，
 *      `MAX_TOKENS = 256`、`OVERLAP_TOKENS = 32`
 *   4. runsql 围栏代码块**单独**派生一个 `runsql` chunk：
 *        "{markdown 前置说明}\n--- SQL ---\n{sql}\n--- Schema ---\n{cols}\n--- Sample ---\n{first_row}\n--- Stats ---\nrows=N elapsed=Ts"
 *      `detail` html 紧跟 fence 时一起吸入（与编辑器 round-trip 行为对齐）。
 *
 * 不依赖 remark / mdast：扫文本即可。这是 v0.3 vault-index 同款思路——足够覆盖 95%
 * 笔记，且无须把 prosemirror 拖进 indexer。少数边角（嵌套围栏、setext heading）
 * 会被识别为 "no heading"，仍能进索引、检索可达，只是 heading 元信息缺失。
 *
 * Token 估算：BERT/E5 family 的中英文混合 token 平均 1 char ≈ 0.4 token，
 * 严格走 tokenizer 会让 chunker 强耦合到模型；这里用经验估算 `Math.ceil(chars * 0.5)`
 * 作上界，宁多勿少。indexer 真正 embed 前如果超 model max_seq_length 再做 hard cut。
 */

import { createHash } from "node:crypto";

import type { KnowledgeChunkSourceKind } from "@shared/types";

/** 一个待嵌入 / 待检索单元。 */
export interface KnowledgeChunk {
  /** 全局唯一 chunk id（sha1 of "${relPath}::${sourceKind}::${ordinal}::${content}"） */
  chunkId: string;
  /** vault 根相对 POSIX 路径 */
  relPath: string;
  sourceKind: KnowledgeChunkSourceKind;
  /** 在该 source 内的顺序号（从 0 起） */
  ordinal: number;
  /** runsql chunk 对应的 blockId；note chunk 为 null */
  blockId: string | null;
  /** 章节 heading slug；无 heading 时为 null */
  headingSlug: string | null;
  /** 章节 heading 文本；无 heading 时为 null */
  headingText: string | null;
  /** 待嵌入的纯文本（不含 markdown 装饰） */
  content: string;
  /** 估算 token 数（chars * 0.5 上界） */
  tokenCount: number;
}

/** chunker 的输入。`runsqlBlocks` 由 indexer 从 `<detail>` html 里抽取后传入。 */
export interface ChunkInput {
  relPath: string;
  /** 文件全文（frontmatter + body） */
  content: string;
  /** 笔记 title（用于 runsql chunk 的元信息），可选 */
  title?: string | null;
  /**
   * 笔记里出现过的 runsql block 派生数据（detail 元信息 + schema sample）。
   * 来源：`extractRunsqlBlocks(content)` 抽 fence + 紧跟 `<detail>` 配对，
   * 由 indexer 在调 chunker 前预处理（与 export-note.ts 行为一致）。
   */
  runsqlBlocks?: RunsqlBlockExtract[];
}

export interface RunsqlBlockExtract {
  blockId: string | null;
  /** 该 runsql block 的 markdown 上下文（紧邻的上方说明段落） */
  markdownContext: string;
  sql: string;
  /** 已解析的 `<detail>` 字段；缺失走 null */
  detail: {
    runDate?: string;
    elapsed?: string;
    rowCount?: number;
    firstRow?: string;
    resultRefId?: string;
  } | null;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
/** Token 估算系数。中英文混合保守取 0.5，超过模型 max_seq_length 时 indexer 再硬截。 */
const TOKENS_PER_CHAR = 0.5;
/** 单 chunk 目标 token 上界（与 multilingual-e5-small max_seq=512 留缓冲）。 */
const MAX_TOKENS = 256;
/** 相邻 chunk overlap，避免句子被腰斩。 */
const OVERLAP_TOKENS = 32;
/** 单段最少 token；过短的 chunk 召回噪音多，与下一段合并。 */
const MIN_TOKENS = 24;

const STRIP_PUNCT_RE = /[!@#$%^&*()+=\[\]{}\\|<>?,.:;'"`~/]/g;

/** 与 [`vault-index.ts`](../vault-index.ts) 的 slugify 完全一致。 */
function slugify(text: string): string {
  const base = text
    .toLowerCase()
    .replace(STRIP_PUNCT_RE, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "section";
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length * TOKENS_PER_CHAR));
}

function sha1(input: string): string {
  return createHash("sha1").update(input).digest("hex");
}

function chunkIdOf(
  relPath: string,
  sourceKind: KnowledgeChunkSourceKind,
  ordinal: number,
  content: string,
): string {
  return sha1(`${relPath}::${sourceKind}::${ordinal}::${content}`);
}

/** 全文 sha256，用于 source_hash diff 决定增量重算。 */
export function hashSourceContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** body 拆出来供后续 section 切分。 */
function stripFrontmatter(text: string): string {
  const m = FRONTMATTER_RE.exec(text);
  if (!m) return text;
  return text.slice(m[0].length);
}

interface Section {
  headingSlug: string | null;
  headingText: string | null;
  /** 章节 body（不含 heading 行） */
  body: string;
}

/**
 * 把 markdown body 按 heading 切成 section。fence 内的 # 不算 heading。
 * 第一个 heading 之前的内容归入 "intro" section（headingSlug=null）。
 */
function splitIntoSections(body: string): Section[] {
  const lines = body.split(/\r?\n/);
  const out: Section[] = [];
  let cur: Section = { headingSlug: null, headingText: null, body: "" };
  let inFence = false;
  let fenceMarker = "";
  const slugCounts = new Map<string, number>();

  const flush = () => {
    if (cur.body.trim() === "" && out.length > 0) return;
    out.push({ ...cur, body: cur.body.replace(/\n+$/, "") });
  };

  for (const raw of lines) {
    const trimmed = raw.trimStart();
    if (!inFence && (trimmed.startsWith("```") || trimmed.startsWith("~~~"))) {
      inFence = true;
      fenceMarker = trimmed.startsWith("```") ? "```" : "~~~";
      cur.body += raw + "\n";
      continue;
    }
    if (inFence) {
      cur.body += raw + "\n";
      if (trimmed.startsWith(fenceMarker)) {
        inFence = false;
        fenceMarker = "";
      }
      continue;
    }
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(trimmed);
    if (m) {
      flush();
      const text = m[2].trim();
      const base = slugify(text);
      const seen = slugCounts.get(base) ?? 0;
      const slug = seen === 0 ? base : `${base}-${seen}`;
      slugCounts.set(base, seen + 1);
      cur = { headingSlug: slug, headingText: text, body: "" };
      continue;
    }
    cur.body += raw + "\n";
  }
  flush();
  return out;
}

/**
 * 把 section body 按段落 + token 阈值切。返回若干"窗口"。
 *
 * 简单 line-based packing：累积段落直到 token > MAX_TOKENS，flush 出一个窗口；
 * 下一窗口从前一窗口尾部回退 OVERLAP_TOKENS 起头。这种实现对中文段落天然友好
 * （以空行为段落分界），不依赖 sentence segmentation。
 */
function packParagraphs(text: string): string[] {
  const stripped = stripMarkdownNoise(text).trim();
  if (!stripped) return [];
  const rawParagraphs = stripped
    .split(/\r?\n\s*\r?\n/)
    .filter((p) => p.trim());
  if (rawParagraphs.length === 0) return [];
  // 先把超长单段（> 2 * MAX_TOKENS）硬切成等长片段。
  // 防御理由：embedder 用的 multilingual-e5-small max_position_embeddings = 512，
  // SentencePiece 对中文 ≈ 1 char/token。一个 5000+ char 的"巨段"（常见于
  // 复制粘贴的长 JSON / 表格 / base64）会把 onnxruntime 输入推到 5000+ token，
  // 即便 transformers.js 端 truncation=True，也观察到在 macOS arm64 上偶发
  // native abort。这里在 chunker 上游就把 char 数限制在 ~MAX_TOKENS*2 / 0.5
  // = 1024 char 以内，留足 max=512 token 的余量。
  const HARD_CHAR_CAP = Math.floor((MAX_TOKENS * 2) / TOKENS_PER_CHAR);
  const paragraphs: string[] = [];
  for (const p of rawParagraphs) {
    if (p.length <= HARD_CHAR_CAP) {
      paragraphs.push(p);
      continue;
    }
    // 按 HARD_CHAR_CAP 等切；保留 ~ OVERLAP_TOKENS 字符 overlap 减少边界腰斩
    const overlapChars = Math.floor(OVERLAP_TOKENS / TOKENS_PER_CHAR);
    const stride = Math.max(1, HARD_CHAR_CAP - overlapChars);
    for (let start = 0; start < p.length; start += stride) {
      const end = Math.min(p.length, start + HARD_CHAR_CAP);
      const slice = p.slice(start, end).trim();
      if (slice) paragraphs.push(slice);
      if (end === p.length) break;
    }
  }

  const windows: string[] = [];
  let cur = "";
  let curTokens = 0;
  for (const p of paragraphs) {
    const pTokens = estimateTokens(p);
    if (curTokens > 0 && curTokens + pTokens > MAX_TOKENS) {
      windows.push(cur.trim());
      const overlap = takeTail(cur, OVERLAP_TOKENS / TOKENS_PER_CHAR);
      cur = overlap ? overlap + "\n\n" + p : p;
      curTokens = estimateTokens(cur);
      continue;
    }
    cur = cur ? cur + "\n\n" + p : p;
    curTokens += pTokens;
  }
  if (cur.trim()) windows.push(cur.trim());

  // 合并尾部过短的 chunk（小于 MIN_TOKENS）到前一段
  const merged: string[] = [];
  for (const w of windows) {
    const tokens = estimateTokens(w);
    if (tokens < MIN_TOKENS && merged.length > 0) {
      merged[merged.length - 1] = merged[merged.length - 1] + "\n\n" + w;
    } else {
      merged.push(w);
    }
  }
  return merged;
}

function takeTail(text: string, chars: number): string {
  const n = Math.min(text.length, Math.floor(chars));
  if (n <= 0) return "";
  return text.slice(text.length - n);
}

/**
 * 去掉 markdown 装饰对 embedding 噪音大的内容：
 *   - 围栏代码块（runsql 已单独成 chunk，普通 code 与说明意图弱关联）
 *   - HTML 注释
 *   - 行内 image 语法 `![alt](url)` → 保留 alt
 *   - link 语法 `[text](url)` → 保留 text
 *   - 行首 list / quote / 表格分割符（| --- |）
 */
function stripMarkdownNoise(text: string): string {
  let s = text;
  // 围栏代码块
  s = s.replace(/```[\s\S]*?```/g, "");
  s = s.replace(/~~~[\s\S]*?~~~/g, "");
  // HTML 注释 / detail 块
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<detail[\s\S]*?<\/detail>/g, "");
  // image / link → 留 alt / text
  s = s.replace(/!\[([^\]]*)\]\([^\)]*\)/g, "$1");
  s = s.replace(/\[([^\]]+)\]\([^\)]*\)/g, "$1");
  // 表格分隔行
  s = s.replace(/^\s*\|?\s*[-: ]+\|[-:| ]*$/gm, "");
  // 行首 markdown 标记符
  s = s.replace(/^\s{0,3}(?:[-*+]\s+|\d+\.\s+|>\s?)/gm, "");
  // 折叠多个空白行
  s = s.replace(/\n{3,}/g, "\n\n");
  return s;
}

/**
 * 主入口：把一个 source（文件 + 可选 runsql 派生）切成 chunks 列表。
 */
export function chunkSource(input: ChunkInput): KnowledgeChunk[] {
  const out: KnowledgeChunk[] = [];
  let ordinal = 0;

  const body = stripFrontmatter(input.content);
  const sections = splitIntoSections(body);
  for (const sec of sections) {
    const windows = packParagraphs(sec.body);
    for (const w of windows) {
      const content = w.trim();
      if (!content) continue;
      out.push({
        chunkId: chunkIdOf(input.relPath, "note", ordinal, content),
        relPath: input.relPath,
        sourceKind: "note",
        ordinal,
        blockId: null,
        headingSlug: sec.headingSlug,
        headingText: sec.headingText,
        content,
        tokenCount: estimateTokens(content),
      });
      ordinal += 1;
    }
  }

  if (input.runsqlBlocks && input.runsqlBlocks.length > 0) {
    let rsOrdinal = 0;
    for (const blk of input.runsqlBlocks) {
      const content = renderRunsqlChunkContent(blk, input.title ?? null);
      if (!content.trim()) {
        rsOrdinal += 1;
        continue;
      }
      out.push({
        chunkId: chunkIdOf(input.relPath, "runsql", rsOrdinal, content),
        relPath: input.relPath,
        sourceKind: "runsql",
        ordinal: rsOrdinal,
        blockId: blk.blockId,
        headingSlug: null,
        headingText: null,
        content,
        tokenCount: estimateTokens(content),
      });
      rsOrdinal += 1;
    }
  }

  return out;
}

function renderRunsqlChunkContent(
  blk: RunsqlBlockExtract,
  title: string | null,
): string {
  const parts: string[] = [];
  if (title) parts.push(`# ${title}`);
  if (blk.markdownContext.trim()) {
    parts.push(stripMarkdownNoise(blk.markdownContext).trim());
  }
  parts.push("--- SQL ---", blk.sql.trim());
  if (blk.detail) {
    const meta: string[] = [];
    if (blk.detail.rowCount !== undefined)
      meta.push(`rows=${blk.detail.rowCount}`);
    if (blk.detail.elapsed) meta.push(`elapsed=${blk.detail.elapsed}`);
    if (blk.detail.runDate) meta.push(`runAt=${blk.detail.runDate}`);
    if (meta.length > 0) parts.push("--- Stats ---", meta.join(" "));
    if (blk.detail.firstRow) {
      parts.push("--- Sample ---", blk.detail.firstRow.trim());
    }
  }
  return parts.join("\n\n").trim();
}

/**
 * 从 markdown 中抽取 runsql 围栏块 + 紧跟其后的 `<detail>` 配对。
 *
 * 不解析 mdast：行级扫描足以覆盖项目里所有 round-trip 测试通过的格式
 * （与 `src/services/export-note.ts` 的 `parseRunsqlBlocks` 行为对齐）。
 */
export function extractRunsqlBlocks(text: string): RunsqlBlockExtract[] {
  const lines = text.split(/\r?\n/);
  const out: RunsqlBlockExtract[] = [];
  let i = 0;
  let lastParagraph = "";
  let paragraphBuffer = "";
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const fenceMatch = /^```runsql\b/.exec(line.trimStart());
    if (!fenceMatch) {
      // 累积"最近的非空段落"作为上下文
      if (line.trim() === "") {
        if (paragraphBuffer.trim()) lastParagraph = paragraphBuffer.trim();
        paragraphBuffer = "";
      } else if (!line.trimStart().startsWith("```")) {
        paragraphBuffer = paragraphBuffer
          ? paragraphBuffer + "\n" + line
          : line;
      }
      i += 1;
      continue;
    }
    // 读 SQL 到下一个 ```
    const sqlLines: string[] = [];
    i += 1;
    while (i < lines.length && !/^```\s*$/.test((lines[i] ?? "").trimStart())) {
      sqlLines.push(lines[i] ?? "");
      i += 1;
    }
    i += 1; // 跳过结束 fence
    // 跳过 fence 后的空行，看是否紧跟 <detail>
    while (i < lines.length && (lines[i] ?? "").trim() === "") i += 1;
    let detail: RunsqlBlockExtract["detail"] = null;
    let blockId: string | null = null;
    if (i < lines.length && /^<detail\b/.test((lines[i] ?? "").trimStart())) {
      const detailStart = i;
      while (
        i < lines.length &&
        !/<\/detail>/.test(lines[i] ?? "")
      ) {
        i += 1;
      }
      if (i < lines.length) i += 1; // 包含 </detail> 行
      const detailRaw = lines.slice(detailStart, i).join("\n");
      detail = parseDetailFields(detailRaw);
      const bidMatch = /block-id="([^"]+)"/.exec(detailRaw);
      if (bidMatch) blockId = bidMatch[1] ?? null;
    }
    out.push({
      blockId,
      markdownContext: lastParagraph,
      sql: sqlLines.join("\n").trim(),
      detail,
    });
    lastParagraph = "";
    paragraphBuffer = "";
  }
  return out;
}

function parseDetailFields(detailRaw: string): RunsqlBlockExtract["detail"] {
  const pick = (tag: string): string | undefined => {
    const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i");
    const m = re.exec(detailRaw);
    if (!m) return undefined;
    return m[1].trim();
  };
  const rowCountStr = pick("row-count");
  const rowCount = rowCountStr ? Number.parseInt(rowCountStr, 10) : undefined;
  const detail: NonNullable<RunsqlBlockExtract["detail"]> = {};
  const runDate = pick("run-date");
  if (runDate) detail.runDate = runDate;
  const elapsed = pick("elapsed");
  if (elapsed) detail.elapsed = elapsed;
  if (Number.isFinite(rowCount)) detail.rowCount = rowCount;
  const firstRow = pick("first-row");
  if (firstRow) detail.firstRow = firstRow;
  const resultRefId = pick("result-ref-id");
  if (resultRefId) detail.resultRefId = resultRefId;
  return Object.keys(detail).length > 0 ? detail : null;
}
