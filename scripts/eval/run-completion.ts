/**
 * 内联补全评测。mask-and-predict：拿真实 runsql 块在行尾截断，
 * 后半行就是 ground truth——**不需要任何标注**。
 *
 *   export STELA_EVAL_API_KEY=...
 *   export STELA_EVAL_BASE_URL=https://.../v1
 *   export STELA_EVAL_MODEL=...
 *   STELA_EVAL_VAULT=~/some-vault npm run eval:completion -- --save
 *
 * 常用开关：`--cases=10` 先试通链路，`--dry-run` 不发请求只看 prompt，
 * `--no-note-context` 做 heading/prose 的 A/B，`--compare` 对比 baseline，
 * `--concurrency=N` 调并发（默认 6）。
 *
 * 三个指标：
 *   prefixMatch     建议与 ground truth 的逐字符公共前缀占比（越高越好）
 *   hallucinated    建议里出现了「schemaDir 中该表并不存在的列名」的比例（越低越好）
 *   firstTokenMs    首个 delta 到达耗时
 *
 * 响应按 (system+user+model) 的 hash 缓存到 scripts/internal/，
 * prompt 没变的重复运行不再烧 token。
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveDialect } from "@shared/sql-dialect";
import type {
  AiInlineCompletionRequest,
  AiSettings,
  ConnectionEntry,
  ConnectionMap,
} from "@shared/types";

import {
  buildInlineCompletionPrompt,
  referencedTableNames,
} from "../../electron/services/ai/inline-completion";
import {
  buildEvalSettings,
  loadConnection,
  loadTableCatalog as listSchemaDirTables,
  requireCredentials,
  type EvalConnection,
} from "./env";
import { loadSchemaDirTableSchemas } from "../../electron/services/ai/schema-context";
import { streamChatCompletions } from "../../electron/services/ai/provider";
import {
  loadCorpus,
  resolveVaultPath,
  type BlockInfo,
  type NoteInfo,
} from "./corpus";
import { materializeFixture } from "./fixture";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const internalDir = path.join(repoRoot, "scripts", "internal");
const cacheFile = path.join(internalDir, "eval-completion-cache.json");

const SAMPLE_SIZE = 120;
/** 与 sql-inline-completion.ts 的真实触发条件对齐：光标前非空白至少 3 个字符。 */
const MIN_PREFIX_NON_WS = 3;
/** ghost text 只取一行，所以 ground truth 也只比一行。 */
const MIN_TRUTH_CHARS = 4;
/** 超过这个长度的「一行」是数据块而不是 SQL 结构，不属于补全场景。 */
const MAX_TRUTH_CHARS = 200;
/** 单条请求上限。产品里 120ms 后就该出建议，等一分钟已经毫无意义。 */
const REQUEST_TIMEOUT_MS = 60_000;
/** 非 --verbose 时最多打几条跑偏样本。 */
const MAX_DIVERGENT_SAMPLES = 8;

interface MaskCase {
  noteRel: string;
  sql: string;
  prefix: string;
  suffix: string;
  truth: string;
  siblingSqls: string[];
  heading: string | null;
  prose: string | null;
}

interface Report {
  generatedAt: string;
  model: string;
  corpus: { label: string; sampled: number };
  noteContext: boolean;
  prefixMatch: number;
  exactLineMatch: number;
  /** 忽略引号/空白/大小写后与 ground truth 相同 —— 主指标。 */
  looseLineMatch: number;
  /** 一方完整包含另一方：补多了或补少了，方向没错。 */
  compatibleRate: number;
  /** 真值里有中文别名，无从预测。 */
  cjkAliasRate: number;
  /** SQL 结构相同、只有字面量不同：阈值和取值猜不到，不算写歪。 */
  literalOnlyRate: number;
  /** 既不相同也不兼容 —— 真正跑偏的比例。 */
  divergentRate: number;
  hallucinatedColumnRate: number;
  /** 建议里引入了 schemaDir 里不存在的表名的比例（只统计有表引用的 case）。 */
  unknownTableRate: number;
  emptyRate: number;
  firstTokenMsP50: number;
  cacheHits: number;
}

function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MAX_PROSE_CHARS = 500;

/**
 * 复刻 codeblock-nodeview 的 `collectNoteContext`：块上方最近的 heading，
 * 加上 heading 与块之间的最后两段散文。两边算法必须一致，否则评的
 * prompt 不是产品真正发出的那个。
 */
function noteContextFor(
  note: NoteInfo | undefined,
  codeStart: number,
): { heading: string | null; prose: string | null } {
  let nearest = null as NoteInfo["headings"][number] | null;
  for (const heading of note?.headings ?? []) {
    if (heading.start < codeStart && (!nearest || heading.start > nearest.start)) {
      nearest = heading;
    }
  }
  if (!note || !nearest) return { heading: null, prose: null };
  const paragraphs = note.body
    .slice(nearest.start, codeStart)
    .split("\n")
    .slice(1)
    .join("\n")
    .replace(/```[\s\S]*?```/g, "")
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !part.startsWith("#"));
  return {
    heading: nearest.text,
    prose: paragraphs.slice(-2).join("\n").slice(-MAX_PROSE_CHARS) || null,
  };
}

/**
 * 切点模式。`middle` 取每行中间的空白，覆盖面广但几乎采不到「光标停在 FROM
 * 后面」——那恰好是真实使用里最想要建议、也最容易补错表名的时刻。`table`
 * 专门切在 FROM / JOIN 之后，让 ground truth 以表名开头。
 */
type CutMode = "middle" | "table";

const TABLE_KEYWORD_RE = /\b(?:from|join)\s+(?=\S)/gi;

function cutModeFrom(args: Set<string>): CutMode {
  return args.has("--cut=table") ? "table" : "middle";
}

/** 找 `FROM ` / `JOIN ` 之后的切点；没有就返回 null。 */
function tableCutAt(line: string, prevLine: string | undefined): number | null {
  const matches = [...line.matchAll(TABLE_KEYWORD_RE)];
  const last = matches[matches.length - 1];
  if (last) return (last.index ?? 0) + last[0].length;
  // `FROM` 单独结尾、表名在下一行的排版：切在本行缩进之后。
  if (prevLine && /\b(?:from|join)\s*$/i.test(prevLine)) {
    const indent = line.match(/^\s+/);
    if (indent) return indent[0].length;
  }
  return null;
}

/**
 * 在每个块里挑一个「行尾光标」位置：截断点前保留完整前缀，
 * 截断点后的同行剩余文本作为 ground truth，后续行作为 suffix。
 */
function buildCases(
  blocks: BlockInfo[],
  notes: NoteInfo[],
  sampleSize: number,
  cutMode: CutMode,
): MaskCase[] {
  const noteByRel = new Map(notes.map((note) => [note.rel, note]));
  const rng = makeRng(0xc0ffee);
  const byNote = new Map<string, BlockInfo[]>();
  for (const block of blocks) {
    const list = byNote.get(block.noteRel);
    if (list) list.push(block);
    else byNote.set(block.noteRel, [block]);
  }

  const candidates: MaskCase[] = [];
  for (const block of blocks) {
    const lines = block.sql.split("\n");
    if (lines.length < 2) continue;
    // 逐行找可用截断点：在行内某个空白后切开，前半非空白够长、后半够长。
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]!;
      let cutAt: number | null;
      if (cutMode === "table") {
        cutAt = tableCutAt(line, lines[i - 1]);
      } else {
        const cutMatches = [...line.matchAll(/\s+/g)];
        const cut = cutMatches[Math.floor(cutMatches.length / 2)];
        cutAt = cut ? (cut.index ?? 0) + cut[0].length : null;
      }
      if (cutAt === null) continue;
      const head = line.slice(0, cutAt);
      const truth = line.slice(cutAt);
      if (truth.trim().length < MIN_TRUTH_CHARS) continue;
      // ghost text 只在写 SQL 时有意义：注释行里补的是散文，
      // 而三百字符的 JSON 数据块没人会按 Tab 接受。两者都不是补全场景。
      if (/^\s*--/.test(line)) continue;
      if (truth.length > MAX_TRUTH_CHARS) continue;
      const prefix = `${lines.slice(0, i).join("\n")}\n${head}`;
      if (prefix.replace(/\s/g, "").length < MIN_PREFIX_NON_WS) continue;
      const suffix = lines.slice(i + 1).join("\n");
      const siblings = (byNote.get(block.noteRel) ?? [])
        .filter((b) => b.blockIndex !== block.blockIndex)
        .slice(0, 8)
        .map((b) => b.sql);
      candidates.push({
        noteRel: block.noteRel,
        sql: block.sql,
        prefix,
        suffix,
        truth,
        siblingSqls: siblings,
        ...noteContextFor(noteByRel.get(block.noteRel), block.codeStart),
      });
      break;
    }
  }

  // 确定性洗牌后取样，保证跨次运行取到同一批 case。
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j]!, candidates[i]!];
  }
  return candidates.slice(0, sampleSize);
}

function commonPrefixRatio(suggestion: string, truth: string): number {
  if (truth.length === 0) return 1;
  const a = suggestion.trimEnd();
  const b = truth.trimEnd();
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i / b.length;
}

/**
 * 建议与 ground truth 的关系。这个任务本身有多个正确答案——同一个光标位置
 * 「补出 `task_name FROM t`」和「补出 `err_code, task_name FROM t`」都对，
 * 所以只报一个匹配率会把「模型选得不一样」和「模型选错了」混成一个数字。
 *   match         忽略引号/空白/大小写后完全相同
 *   compatible    一方完整包含另一方 —— 多补/少补了几个字段，方向没错
 *   literal       只有字面量不同 —— `query_mem_limit = 214748364800` 里那个阈值
 *                 只存在于作者脑子里，SQL 结构其实补对了
 *   cjk-alias     真值里有中文别名 —— `AS \`回收总量\`` 无从预测，不该记在模型头上
 *   divergent     真的不一样，这才是要看的那部分
 */
type Verdict = "match" | "compatible" | "literal" | "cjk-alias" | "divergent";

/** 包含判定的最短长度：太短的片段互相包含只是巧合。 */
const MIN_CONTAINMENT_CHARS = 8;
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/;

function verdictFor(suggestion: string, truth: string): Verdict {
  const a = looseKey(suggestion);
  const b = looseKey(truth);
  if (a === b) return "match";
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (shorter.length >= MIN_CONTAINMENT_CHARS && longer.includes(shorter)) {
    return "compatible";
  }
  if (structureKey(suggestion) === structureKey(truth)) return "literal";
  // 中文别名是用户当场取的名字，任何模型都猜不中；算进 divergent 会把
  // 「该修的部分」这个数字兑水。两边都写了中文别名、只是取名不同（`待处理量`
  // vs `待迁移量`）同理。
  if (CJK_RE.test(truth) && !CJK_RE.test(suggestion)) return "cjk-alias";
  if (CJK_RE.test(truth) && maskCjkAliases(suggestion) === maskCjkAliases(truth)) {
    return "cjk-alias";
  }
  return "divergent";
}

/** 把反引号里含中文的别名抹掉，只比较别名之外的部分。 */
function maskCjkAliases(text: string): string {
  return looseKey(text.replace(/`[^`]*`/g, (seg) => (CJK_RE.test(seg) ? "`?`" : seg)));
}

/**
 * 只保留 SQL 结构：字符串字面量与数字全部抹成 `?`。用来区分「结构补对了、
 * 只是猜不到那个阈值 / 那个 rtx 值」和「真的写歪了」。
 * 必须在 looseKey 之前抹，否则单引号已经被它当标识符引号剥掉了。
 */
function structureKey(text: string): string {
  return looseKey(text.replace(/'[^']*'/g, "'?'").replace(/\b\d+(?:\.\d+)?\b/g, "?"));
}

/**
 * 「实质相同」：忽略引号风格、空白、大小写、运算符两侧空格。
 * `AS \`base_total\`,` 与 `AS base_total,`、`x=1` 与 `x = 1` 都是同一个建议，
 * 逐字符比较却会算它们错。
 */
function looseKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`"[\]]/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*([(),.])\s*/g, "$1")
    .replace(/\s*(<=|>=|<>|!=|=|<|>|\+|\*|\/|\|\|)\s*/g, "$1")
    // COUNT(1) 和 COUNT(*) 是同一件事，别把风格差异算成错。
    .replace(/count\(1\)/g, "count(*)")
    .trim();
}

/**
 * 建议里**引用了**一个该表并不存在的列，才算幻觉。三类必须排除，否则这个
 * 指标会把正确建议全判成幻觉：
 *   - 建议自己定义的别名（`AS base_total` 里的 base_total 是新名字，不是引用）
 *   - 函数名（`date_format(` 后面跟括号）
 *   - 已经出现在 prefix / suffix / 邻近块 / ground truth 里的名字（用户自己
 *     在用的名字，模型只是抄了下来；DDL 文档可能本来就过期）
 */
function hallucinatedColumn(
  suggestion: string,
  knownColumns: Set<string>,
  knownOther: Set<string>,
): string | null {
  if (knownColumns.size === 0) return null;
  const lower = suggestion.toLowerCase();
  const defined = new Set(
    [...lower.matchAll(/\bas\s+[`"]?([a-z_][a-z0-9_]*)/g)].map((m) => m[1]!),
  );
  for (const match of lower.matchAll(/[a-z_][a-z0-9_]{2,}/g)) {
    const ident = match[0];
    const rest = lower.slice(match.index + ident.length);
    if (/^\s*\(/.test(rest)) continue; // 函数调用
    if (defined.has(ident) || knownColumns.has(ident) || knownOther.has(ident)) continue;
    return ident;
  }
  return null;
}

const SQL_WORDS = new Set(
  `select from where group by having order limit offset join left right inner outer on as and or not null is in like between case when then else end count sum avg min max distinct union all asc desc with cast date interval current_date now cte partition over row_number rank coalesce if ifnull nullif substr substring concat lower upper trim length round floor ceil abs true false`.split(
    /\s+/,
  ),
);

interface CacheEntry {
  text: string;
  firstTokenMs: number;
}

/** 并发取回的原始结果；打分在全部取回后按顺序做，保证输出可读且确定。 */
interface FetchedCase {
  entry: CacheEntry;
  prompt: Awaited<ReturnType<typeof assemblePrompt>>;
  failed?: boolean;
}

async function readCache(): Promise<Record<string, CacheEntry>> {
  try {
    return JSON.parse(await fs.readFile(cacheFile, "utf-8")) as Record<string, CacheEntry>;
  } catch {
    return {};
  }
}

async function writeCache(cache: Record<string, CacheEntry>): Promise<void> {
  await fs.mkdir(internalDir, { recursive: true });
  await fs.writeFile(cacheFile, `${JSON.stringify(cache)}\n`, "utf-8");
}

function identsIn(text: string): string[] {
  return text.toLowerCase().match(/[a-z_][a-z0-9_]{2,}/g) ?? [];
}

/**
 * schemaDir 里的表名全集（`db.table.md` 文件名）。用来判断建议里的表名
 * 是否真的存在——「编了一张不存在的表」和「选了另一张存在的表」是两类
 * 完全不同的错误：前者靠给出候选表名可修，后者只能靠业务上下文。
 */
async function loadTableCatalog(connection: EvalConnection): Promise<Set<string>> {
  const names = new Set<string>();
  for (const stem of await listSchemaDirTables(connection)) {
    names.add(stem.toLowerCase());
    const bare = stem.toLowerCase().split(".").pop();
    if (bare) names.add(bare);
  }
  return names;
}

/**
 * 建议里**新引入**的表引用。FROM / JOIN 关键字可能落在 prefix 里（光标就停在
 * `FROM ` 后面），所以要把 prefix 尾巴接上一起扫，再按位置筛出属于建议的那些。
 */
function newTableRefs(prefixTail: string, suggestion: string): string[] {
  const combined = `${prefixTail}${suggestion}`;
  const out: string[] = [];
  for (const m of combined.matchAll(/\b(?:from|join|into|update)\s+([`"]?[\w.]+[`"]?)/gi)) {
    const nameStart = (m.index ?? 0) + m[0].length - m[1]!.length;
    if (nameStart < prefixTail.length) continue; // 整个表名来自 prefix，不是这次补的
    const name = m[1]!.replace(/[`"]/g, "").toLowerCase();
    if (name) out.push(name);
  }
  return out;
}

/** `--cases=30` → 30。 */
function numericArg(args: Set<string>, name: string): number | null {
  for (const arg of args) {
    if (!arg.startsWith(`${name}=`)) continue;
    const value = Number.parseInt(arg.slice(name.length + 1), 10);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/** 走的是产品同一个 buildInlineCompletionPrompt，dry-run 与实跑共用。 */
async function assemblePrompt(
  testCase: MaskCase,
  index: number,
  connection: EvalConnection,
  withNoteContext: boolean,
): Promise<{
  system: string;
  user: string;
  tables: string[];
  schemas: Awaited<ReturnType<typeof loadSchemaDirTableSchemas>>;
}> {
  const request: AiInlineCompletionRequest = {
    requestId: `eval-${index}`,
    prefix: testCase.prefix,
    suffix: testCase.suffix,
    siblingSqls: testCase.siblingSqls,
    connectionName: connection?.name ?? null,
    // tableSchemas 故意留空：那是 renderer 列缓存（真实 connector 探针）的
    // 输入，评测脚本没有活连接，用 schemaDir 的列去填等于自己给自己漏题。
    heading: withNoteContext ? testCase.heading : null,
    prose: withNoteContext ? testCase.prose : null,
  };
  const tables = referencedTableNames(request);
  const schemas = connection
    ? await loadSchemaDirTableSchemas({
        connectionName: connection.name,
        schemaDir: connection.entry.schemaDir,
        tableNames: tables,
      })
    : [];
  const dialect = connection
    ? resolveDialect({ kind: connection.entry.kind, displayName: connection.entry.kind })
    : "Standard SQL";
  return {
    ...buildInlineCompletionPrompt({ request, dialect, tables, schemas }),
    tables,
    schemas,
  };
}

async function dryRun(args: Set<string>): Promise<void> {
  const useFixture = args.has("--fixture");
  const vaultPath = useFixture ? await materializeFixture() : resolveVaultPath();
  const corpus = await loadCorpus(vaultPath);
  const connection = await loadConnection(vaultPath);
  const withNoteContext = !args.has("--no-note-context");
  const cases = buildCases(corpus.blocks, corpus.notes, SAMPLE_SIZE, cutModeFrom(args));
  if (cases.length === 0) throw new Error("no maskable runsql blocks found in this vault");

  let withHeading = 0;
  let withProse = 0;
  let withSchema = 0;
  for (const testCase of cases) {
    if (testCase.heading) withHeading++;
    if (testCase.prose) withProse++;
  }
  const shown: string[] = [];
  for (let i = 0; i < cases.length; i++) {
    const { user, schemas } = await assemblePrompt(cases[i]!, i, connection, withNoteContext);
    if (schemas.length > 0) withSchema++;
    if (shown.length < 1 && cases[i]!.heading) shown.push(user);
  }

  const pct = (count: number) => `${((count / cases.length) * 100).toFixed(0)}%`;
  console.log(`\ndry run  [${cases.length} cases, ${useFixture ? "fixture" : "real vault"}]`);
  console.log(`  cases with heading   ${withHeading} (${pct(withHeading)})`);
  console.log(`  cases with prose     ${withProse} (${pct(withProse)})`);
  console.log(`  cases with schema    ${withSchema} (${pct(withSchema)})`);
  console.log(`  note context sent    ${withNoteContext}`);
  if (shown[0]) console.log(`\n--- sample prompt ---\n${shown[0]}\n`);
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  // --dry-run：只组 prompt 不发请求。既是无 token 时的自查（能看出 heading /
  // prose / schema 有没有真的进 prompt），也省得为了改 prompt 反复烧 token。
  if (args.has("--dry-run")) {
    await dryRun(args);
    return;
  }
  const { apiKey, baseUrl, model } = requireCredentials();

  const useFixture = args.has("--fixture");
  // --cases=N：先用几条试通链路，别为了发现 model 名写错等 20 分钟。
  const sampleSize = numericArg(args, "--cases") ?? SAMPLE_SIZE;
  console.log(`model ${model} @ ${baseUrl}, ${sampleSize} cases max`);
  const vaultPath = useFixture ? await materializeFixture() : resolveVaultPath();
  process.stdout.write(`loading corpus from ${vaultPath} ... `);
  const corpus = await loadCorpus(vaultPath);
  console.log(`${corpus.notes.length} notes, ${corpus.blocks.length} runsql blocks`);
  const connection = await loadConnection(vaultPath);
  // --no-note-context 用来 A/B 轨道 B 的 heading/prose 收益：prompt 不同
  // 会自然落到不同的缓存 key，两次跑各自缓存。
  const withNoteContext = !args.has("--no-note-context");
  const cutMode = cutModeFrom(args);
  const cases = buildCases(corpus.blocks, corpus.notes, sampleSize, cutMode);
  if (cases.length === 0) throw new Error("no maskable runsql blocks found in this vault");
  console.log(
    `${cases.length} cases, connection ${connection?.name ?? "(none)"}, ` +
      `note context ${withNoteContext}, cut ${cutMode}\n`,
  );

  const settings = buildEvalSettings(model, baseUrl);
  const cache = await readCache();
  let cacheHits = 0;

  const prefixMatches: number[] = [];
  const firstTokenTimes: number[] = [];
  let exactLines = 0;
  let hallucinations = 0;
  let hallucinationChecked = 0;
  let empties = 0;
  let failures = 0;
  let looseMatches = 0;
  let compatibles = 0;
  let cjkAliases = 0;
  let literalOnly = 0;
  let scored = 0;
  let unknownTables = 0;
  let tableRefsChecked = 0;
  const catalog = await loadTableCatalog(connection);
  // 一个 67% 的数字没法判断是模型不行还是指标不行，所以总是留几条跑偏样本；
  // 小规模跑或 --verbose 时全都打出来。
  const showDetail = args.has("--verbose") || cases.length <= 20;
  const divergentSamples: string[] = [];

  // 每条请求 5~25s，串行跑 120 条要几十分钟；它们互不依赖，所以并发发出。
  // 上限保守取 6：再高就容易吃到服务端限流，反而更慢。
  const concurrency = Math.max(1, numericArg(args, "--concurrency") ?? 6);
  const fetched = new Array<FetchedCase>(cases.length);
  const startedAll = Date.now();
  let nextIndex = 0;
  let done = 0;
  let successes = 0;
  let writeQueue = Promise.resolve();

  const worker = async (): Promise<void> => {
    for (let i = nextIndex++; i < cases.length; i = nextIndex++) {
      const testCase = cases[i]!;
      const prompt = await assemblePrompt(testCase, i, connection, withNoteContext);
      const key = createHash("sha256")
        .update(`${model}\u0000${prompt.system}\u0000${prompt.user}`)
        .digest("hex");
      const progress = `[${String(++done).padStart(3)}/${cases.length}]`;
      const cached = cache[key];
      if (cached) {
        cacheHits++;
        successes++;
        fetched[i] = { entry: cached, prompt };
        console.log(`${progress} cached      ${testCase.noteRel}`);
        continue;
      }

      const controller = new AbortController();
      // 一条请求挂死不该拖垮整轮：超时后当作失败继续，缓存里不落这一条。
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let text = "";
      let failure = "";
      const started = Date.now();
      let firstTokenMs = 0;
      try {
        await streamChatCompletions({
          settings,
          apiKey,
          system: prompt.system,
          user: prompt.user,
          profileId: "eval",
          signal: controller.signal,
          onDelta: (delta) => {
            if (!firstTokenMs) firstTokenMs = Date.now() - started;
            text += delta;
          },
        });
      } catch (err) {
        failure = err instanceof Error ? err.message : String(err);
      } finally {
        clearTimeout(timeout);
      }
      const elapsed = Date.now() - started;
      const entry: CacheEntry = { text, firstTokenMs: firstTokenMs || elapsed };
      fetched[i] = { entry, prompt, failed: Boolean(failure) };
      if (failure) {
        failures++;
        console.log(`${progress} FAILED ${elapsed} ms  ${testCase.noteRel}: ${failure}`);
        // 配置写错时别烧完整轮：头一批全挂且无一成功，直接停。
        if (successes === 0 && failures >= concurrency) {
          throw new Error(
            `the first ${failures} requests all failed (${failure}). ` +
              "check STELA_EVAL_MODEL / _BASE_URL / _API_KEY before spending a full run.",
          );
        }
        continue;
      }
      successes++;
      cache[key] = entry;
      console.log(
        `${progress} ${String(elapsed).padStart(6)} ms  ${testCase.noteRel}  (${text.length} chars)`,
      );
      // 缓存边跑边落盘：中途 Ctrl+C 不该把已花的 token 全丢掉。串成一条链
      // 避免并发 worker 同时写同一个文件。
      if (successes % 10 === 0) {
        writeQueue = writeQueue.then(() => writeCache(cache));
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, cases.length) }, worker));
  await writeQueue;
  console.log(
    `\nfetched ${cases.length} cases in ${((Date.now() - startedAll) / 1000).toFixed(1)}s ` +
      `(concurrency ${concurrency})`,
  );

  for (let i = 0; i < cases.length; i++) {
    const testCase = cases[i]!;
    const result = fetched[i];
    // 请求失败的 case 不参与打分：把它当成「空建议」会同时污染
    // emptyRate 与 prefixMatch，让一次网络抖动看起来像模型退步。
    if (!result || result.failed) continue;
    const { entry } = result;
    const { tables, schemas } = result.prompt;

    // 与 renderer 的 normalize 对齐到「只取第一行、剥掉 fence」这一层。
    const suggestion = entry.text
      .replace(/^```[a-z]*\n?/i, "")
      .replace(/```$/, "")
      .split("\n")[0] ?? "";
    scored++;
    if (!suggestion.trim()) empties++;
    prefixMatches.push(commonPrefixRatio(suggestion, testCase.truth));
    if (suggestion.trimEnd() === testCase.truth.trimEnd()) exactLines++;
    const verdict = verdictFor(suggestion, testCase.truth);
    if (verdict === "match") looseMatches++;
    if (verdict === "compatible") compatibles++;
    if (verdict === "literal") literalOnly++;
    if (verdict === "cjk-alias") cjkAliases++;
    firstTokenTimes.push(entry.firstTokenMs);

    const knownColumns = new Set(
      schemas.flatMap((s) => (s.columns ?? []).map((c) => c.name.toLowerCase())),
    );
    const knownOther = new Set([
      ...SQL_WORDS,
      ...tables.flatMap((t) => t.toLowerCase().split(".")),
      ...schemas.flatMap((s) => [s.table?.toLowerCase() ?? "", s.database?.toLowerCase() ?? ""]),
      // 用户自己已经在用的名字不算模型编的——DDL 文档过期比模型幻觉常见。
      ...identsIn(testCase.prefix),
      ...identsIn(testCase.suffix),
      ...identsIn(testCase.truth),
      ...testCase.siblingSqls.flatMap(identsIn),
    ]);
    let hallucinated: string | null = null;
    if (knownColumns.size > 0) {
      hallucinationChecked++;
      hallucinated = hallucinatedColumn(suggestion, knownColumns, knownOther);
      if (hallucinated) hallucinations++;
    }

    let unknownTable: string | null = null;
    const refs = catalog.size > 0 ? newTableRefs(testCase.prefix.slice(-200), suggestion) : [];
    if (refs.length > 0) {
      tableRefsChecked++;
      for (const ref of refs) {
        const bare = ref.split(".").pop() ?? ref;
        // CTE / 用户自己写过的名字不算编的：schemaDir 文档缺一张表很常见。
        if (catalog.has(ref) || catalog.has(bare)) continue;
        if (identsIn(testCase.prefix).includes(bare)) continue;
        if (testCase.siblingSqls.some((sql) => identsIn(sql).includes(bare))) continue;
        unknownTable = ref;
        unknownTables++;
        break;
      }
    }
    if (verdict === "divergent" && (showDetail || divergentSamples.length < MAX_DIVERGENT_SAMPLES)) {
      // 带上光标两侧：绝大多数跑偏一眼就能看出是缺上下文还是模型没推理，
      // 只看 truth/got 判断不了。
      divergentSamples.push(
        `  ${testCase.noteRel}\n` +
          `        before ${JSON.stringify(testCase.prefix.slice(-160))}\n` +
          `        truth  ${JSON.stringify(testCase.truth)}\n` +
          `        got    ${JSON.stringify(suggestion)}\n` +
          `        after  ${JSON.stringify(testCase.suffix.slice(0, 120))}` +
          (hallucinated ? `\n        unknown column: ${hallucinated}` : "") +
          (unknownTable ? `\n        unknown table:  ${unknownTable}` : ""),
      );
    }
  }

  const n = Math.max(1, scored);
  const report: Report = {
    generatedAt: new Date().toISOString(),
    model,
    corpus: { label: useFixture ? "fixture" : "real vault", sampled: scored },
    noteContext: withNoteContext,
    prefixMatch: prefixMatches.reduce((a, b) => a + b, 0) / n,
    exactLineMatch: exactLines / n,
    looseLineMatch: looseMatches / n,
    compatibleRate: compatibles / n,
    cjkAliasRate: cjkAliases / n,
    literalOnlyRate: literalOnly / n,
    divergentRate: (n - looseMatches - compatibles - cjkAliases - literalOnly) / n,
    hallucinatedColumnRate: hallucinationChecked > 0 ? hallucinations / hallucinationChecked : 0,
    unknownTableRate: tableRefsChecked > 0 ? unknownTables / tableRefsChecked : 0,
    emptyRate: empties / n,
    firstTokenMsP50: median(firstTokenTimes),
    cacheHits,
  };

  await writeCache(cache);

  const suffix =
    `${useFixture ? "fixture" : "real"}` +
    `${cutMode === "middle" ? "" : `.cut-${cutMode}`}` +
    `${withNoteContext ? "" : ".no-note-context"}`;
  const baselineFile = path.join(internalDir, `eval-completion-baseline.${suffix}.json`);
  let baseline: Report | null = null;
  if (args.has("--compare")) {
    try {
      baseline = JSON.parse(await fs.readFile(baselineFile, "utf-8")) as Report;
    } catch {
      baseline = null;
    }
  }

  const delta = (now: number, before: number | undefined): string =>
    before === undefined ? "" : `  (${now - before > 0 ? "+" : ""}${((now - before) * 100).toFixed(1)}pp)`;

  console.log(
    `\ncompletion eval  [${scored} scored, ${cacheHits} cached, ${failures} failed (excluded), model ${model}]`,
  );
  console.log(
    `  match                 ${(report.looseLineMatch * 100).toFixed(1)}%${delta(report.looseLineMatch, baseline?.looseLineMatch)}  same as ground truth`,
  );
  console.log(
    `  compatible            ${(report.compatibleRate * 100).toFixed(1)}%${delta(report.compatibleRate, baseline?.compatibleRate)}  contains / contained by ground truth`,
  );
  console.log(
    `  literal only          ${(report.literalOnlyRate * 100).toFixed(1)}%${delta(report.literalOnlyRate, baseline?.literalOnlyRate)}  same structure, different value`,
  );
  console.log(
    `  cjk alias             ${(report.cjkAliasRate * 100).toFixed(1)}%${delta(report.cjkAliasRate, baseline?.cjkAliasRate)}  unpredictable by construction`,
  );
  console.log(
    `  divergent             ${(report.divergentRate * 100).toFixed(1)}%${delta(report.divergentRate, baseline?.divergentRate)}  ← the part worth fixing`,
  );
  console.log(
    `  prefix match          ${(report.prefixMatch * 100).toFixed(1)}%${delta(report.prefixMatch, baseline?.prefixMatch)}`,
  );
  console.log(
    `  exact line match      ${(report.exactLineMatch * 100).toFixed(1)}%${delta(report.exactLineMatch, baseline?.exactLineMatch)}`,
  );
  console.log(
    `  hallucinated columns  ${(report.hallucinatedColumnRate * 100).toFixed(1)}%` +
      `${delta(report.hallucinatedColumnRate, baseline?.hallucinatedColumnRate)}  [${hallucinationChecked} checkable]`,
  );
  console.log(
    `  unknown tables        ${(report.unknownTableRate * 100).toFixed(1)}%` +
      `${delta(report.unknownTableRate, baseline?.unknownTableRate)}  [${tableRefsChecked} with table refs]`,
  );
  console.log(
    `  empty suggestions     ${(report.emptyRate * 100).toFixed(1)}%${delta(report.emptyRate, baseline?.emptyRate)}`,
  );
  // 这个数字属于评测端点，不是产品的补全 profile —— 别拿它当延迟结论。
  console.log(`  first token p50       ${report.firstTokenMsP50} ms  [eval endpoint]`);
  if (scored < 30) {
    console.log(`  ⚠ ${scored} cases is too few to conclude anything; drop --cases for a full run`);
  }
  // tableSchemas 在评测里恒为空（无活连接），所以这轮数字只反映
  // schemaDir DDL + note context 那部分，不含 renderer 列缓存的收益。
  console.log("  note: renderer column cache is not exercised here (no live connector)");
  if (divergentSamples.length > 0) {
    console.log(`\ndivergent samples (${divergentSamples.length}):\n`);
    console.log(divergentSamples.join("\n\n"));
  }
  console.log("");

  if (args.has("--save")) {
    await fs.writeFile(baselineFile, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
    console.log(`saved baseline -> ${path.relative(repoRoot, baselineFile)}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
