/**
 * Agent 提问判准评测（ask_user）。
 *
 * 「遇到拿不准的地方多问用户」这件事没法用单向指标衡量：只看「该问时问了多少」，
 * 一个每次都提问的 agent 拿满分却极其烦人。所以语料**成对**生成：同一个任务两版，
 * 一版目标唯一（该直接做），一版目标有 ≥3 张同族表都能匹配（该反问）。两个方向
 * 都从 proposal 事件里机械数出来，不需要 LLM 裁判。
 *
 *   STELA_EVAL_VAULT=~/some-vault npm run eval:agent-ask -- --dry-run     # 看语料，不发请求
 *   STELA_EVAL_VAULT=~/some-vault npm run eval:agent-ask -- --self-check  # 验接线，不发请求
 *   export STELA_EVAL_API_KEY=... STELA_EVAL_BASE_URL=... STELA_EVAL_MODEL=...
 *   STELA_EVAL_VAULT=~/some-vault npm run eval:agent-ask -- --save
 *
 * 其他开关：`--pairs=N` 限制对数，`--concurrency=N` 调并发（默认 3），
 * `--compare` 与 baseline 对比。
 *
 * 跑的是产品同一份 system prompt（agent-prompt.ts）和同一套工具
 * （agent-tools.ts）。只有三处替身：
 *   connector.execute   假结果，评测不连真库 —— 所以「结论对不对」测不了
 *   recordRun           空实现，不碰 result-store（那需要 Electron ABI）
 *   sqlIndex.query      由语料的 runsql 事实回答，让 search_sql_usage 真的可用
 */

import {
  AgentHarness,
  InMemorySessionStorage,
  Session,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveDialect } from "@shared/sql-dialect";
import type {
  AgentRunRequest,
  QueryResult,
  SqlIndexHit,
  SqlIndexOperation,
} from "@shared/types";

import {
  assistantText,
  buildSystemPrompt,
  buildUserContent,
} from "../../electron/services/ai/agent-prompt";
import {
  createAgentTools,
  dispatchTool,
  type ProposalRequest,
} from "../../electron/services/ai/agent-tools";
import { createTransportForProfile } from "../../electron/services/ai/provider";
import { loadCorpus, resolveVaultPath, type BlockInfo } from "./corpus";
import {
  buildEvalSettings,
  loadConnection,
  loadTableCatalog,
  requireCredentials,
  type EvalConnection,
} from "./env";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const internalDir = path.join(repoRoot, "scripts", "internal");

/** 默认成对数量。每对 = 2 个 run，一个 run 通常 4~8 次模型调用。 */
const DEFAULT_PAIRS = 10;
/** 同族至少要这么多张表才算「说不清」。2 张容易被上下文碰巧消歧，3 张才稳。 */
const MIN_FAMILY_SIZE = 3;
/**
 * 同族里至少要有这么多张**真被用过**。只有一张被用过时，「评估集」其实并不
 * 含糊——聪明的 agent 直接选那张才对，此时反问反而是错的，标签会失真。
 */
const MIN_USED_IN_FAMILY = 2;
/** 单个 run 的工具调用上限，超了就 abort：防止一个 run 烧掉半轮预算。 */
const MAX_TOOL_CALLS = 24;
/** 单个 run 的墙钟上限。 */
const RUN_TIMEOUT_MS = 240_000;
/** 假结果里的行数，好让模型有个数字可用。 */
const FAKE_ROW_COUNT = 4213;

interface Family {
  /** 共享词干，去掉变化位，如 `shapegen part dataset` */
  stem: string;
  /** 全名（`db.table`），按字典序 */
  members: string[];
  /** 其中真被 runsql 用过的成员 */
  used: string[];
}

interface AskCase {
  id: string;
  kind: "ambiguous" | "clear";
  prompt: string;
  family: Family;
  /** 模型反问时回给它的答案 */
  answer: string;
}

interface RunOutcome {
  asked: boolean;
  questions: string[];
  toolCalls: string[];
  /** get_table_schema / run_sql 里出现过的表名（小写裸名） */
  tablesTouched: string[];
  finalText: string;
  aborted: boolean;
  error: string;
  elapsedMs: number;
}

interface Report {
  generatedAt: string;
  model: string;
  pairs: number;
  askedWhenAmbiguous: number;
  askedWhenClear: number;
  askGap: number;
  /** 该问却没问、且最终答复里也没交代自己做了什么假设的比例 */
  silentGuessRate: number;
  assumptionStatedWhenGuessing: number;
  avgToolCallsAmbiguous: number;
  avgToolCallsClear: number;
  failures: number;
}

/**
 * 从 schemaDir 的表名里机械地找「同族表」：按 `_` 切词，逐位挖空当作族键。
 * `shapegen_part_{eval,train,full}_dataset` 会落到同一个键上。
 *
 * 这样语料完全由 vault 决定，既不用手写、也不会把私有表名写进仓库。
 */
export function buildFamilies(catalog: string[], usedBareNames: Set<string>): Family[] {
  const groups = new Map<string, Set<string>>();
  for (const qualified of catalog) {
    const dot = qualified.indexOf(".");
    if (dot <= 0) continue;
    const db = qualified.slice(0, dot);
    const tokens = qualified.slice(dot + 1).split("_");
    if (tokens.length < 3) continue;
    for (let i = 0; i < tokens.length; i++) {
      // 只跳过首词：前缀不同的表通常不是同一组东西。末位放开，让
      // `..._final_{entity,summary,task}` 这类需要用户消歧的家族保留下来。
      if (i === 0) continue;
      const key = `${db}|${tokens.map((t, j) => (j === i ? "*" : t)).join("_")}`;
      const bucket = groups.get(key) ?? new Set<string>();
      bucket.add(qualified);
      groups.set(key, bucket);
    }
  }

  const families: Family[] = [];
  for (const [key, bucket] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (bucket.size < MIN_FAMILY_SIZE) continue;
    const members = [...bucket].sort();
    const used = members.filter((m) => usedBareNames.has(m.split(".").pop()!.toLowerCase()));
    if (used.length < MIN_USED_IN_FAMILY) continue;
    const stem = key
      .slice(key.indexOf("|") + 1)
      .split("_")
      .filter((t) => t !== "*")
      .join(" ");
    if (stem.length < 6) continue;
    families.push({ stem, members, used });
  }
  return families;
}

/**
 * 成对任务。任务本身必须毫无歧义（数行数），**唯一**的变量是目标表说不说清，
 * 否则测到的就不是提问判准而是别的东西。
 */
function buildCases(families: Family[], pairs: number): AskCase[] {
  const cases: AskCase[] = [];
  for (const family of families.slice(0, pairs)) {
    // 反问时回最常见的那张：答案取哪张不影响指标，但要确定性。
    const answer = family.used[0]!;
    cases.push({
      id: `${family.stem}#ambiguous`,
      kind: "ambiguous",
      prompt: `帮我数一下 ${family.stem} 这张表现在有多少行。`,
      family,
      answer,
    });
    cases.push({
      id: `${family.stem}#clear`,
      kind: "clear",
      prompt: `帮我数一下 ${answer} 这张表现在有多少行。`,
      family,
      answer,
    });
  }
  return cases;
}

/** 用语料里的 runsql 事实回答 search_sql_usage，替掉需要 Electron 的 sql-index。 */
function corpusSqlIndex(blocks: BlockInfo[], vaultPath: string) {
  return {
    query: async (filter: {
      readTable?: string;
      writeTable?: string;
      operations?: SqlIndexOperation[];
      maxHits?: number;
    }): Promise<SqlIndexHit[]> => {
      const read = filter.readTable?.split(".").pop()?.toLowerCase();
      const write = filter.writeTable?.split(".").pop()?.toLowerCase();
      const hits: SqlIndexHit[] = [];
      for (const block of blocks) {
        if (read && !block.readTables.includes(read)) continue;
        if (write && !block.writeTables.includes(write)) continue;
        if (!read && !write) continue;
        hits.push({
          path: path.join(vaultPath, block.noteRel),
          relPath: block.noteRel,
          blockIndex: block.blockIndex,
          line: block.codeStart,
          blockId: null,
          connectionName: null,
          dialect: null,
          runDate: null,
          operations: block.writeTables.length > 0 ? ["update"] : ["select"],
          snippet: block.sql.slice(0, 400),
        });
        if (hits.length >= (filter.maxHits ?? 60)) break;
      }
      return hits;
    },
  };
}

function fakeQueryResult(sql: string): QueryResult {
  if (!/^\s*(select|with|show|desc)/i.test(sql)) {
    return { kind: "mutation", affectedRows: 0, elapsedMs: 12 };
  }
  return {
    kind: "query",
    columns: [{ name: "count(1)", typeName: "BIGINT" }],
    rows: [[FAKE_ROW_COUNT]],
    elapsedMs: 12,
  };
}

function bareTablesIn(text: string): string[] {
  return [...text.toLowerCase().matchAll(/\b([a-z_][\w]*)\.([a-z_][\w]*)/g)].map((m) => m[2]!);
}

interface EvalWorld {
  vaultPath: string;
  connection: EvalConnection;
  catalog: string[];
  blocks: BlockInfo[];
}

/**
 * 工具上下文：除了三处替身（execute / recordRun / sqlIndex），其余都是产品真货。
 * `run_sql` 走真的 sql-guard、`search_tables` 走真的 schema-context、
 * `search_vault` 走真的排名检索。
 */
function buildToolContext(world: EvalWorld, runId: string, settings: AiSettings) {
  const entry = world.connection?.entry ?? null;
  return {
    vaultPath: world.vaultPath,
    connectionName: world.connection?.name ?? null,
    connection: entry,
    aiSettings: settings,
    connector: {
      listKinds: () =>
        entry ? [{ kind: entry.kind, displayName: entry.kind, dialect: "mysql" }] : [],
      listDatabases: async () => [...new Set(world.catalog.map((t) => t.split(".")[0]!))],
      listTables: async (_kind: string, _config: unknown, db?: string | null) =>
        world.catalog.filter((t) => !db || t.startsWith(`${db}.`)).map((t) => t.split(".").pop()!),
      execute: async (_kind: string, _config: unknown, sql: string) => fakeQueryResult(sql),
    },
    sqlIndex: corpusSqlIndex(world.blocks, world.vaultPath),
    run: { runId, notePath: null, questionsAsked: 0 },
    recordRun: async () => {},
  };
}

async function runOne(
  testCase: AskCase,
  world: EvalWorld,
  credentials: ReturnType<typeof requireCredentials>,
): Promise<RunOutcome> {
  const settings = buildEvalSettings(credentials.model, credentials.baseUrl);
  const { models, model } = createTransportForProfile(settings, credentials.apiKey, "eval");
  const { connection, vaultPath } = world;
  const entry = connection?.entry ?? null;
  const request: AgentRunRequest = {
    runId: `eval-${testCase.id}`,
    prompt: testCase.prompt,
    connectionName: connection?.name ?? null,
    locale: "zh",
    notePath: null,
  };

  const outcome: RunOutcome = {
    asked: false,
    questions: [],
    toolCalls: [],
    tablesTouched: [],
    finalText: "",
    aborted: false,
    error: "",
    elapsedMs: 0,
  };

  const controller = new AbortController();
  let harness: AgentHarness | null = null;
  const stop = (why: string) => {
    outcome.aborted = true;
    outcome.error ||= why;
    controller.abort();
    void harness?.abort();
  };
  const timer = setTimeout(() => stop("timeout"), RUN_TIMEOUT_MS);

  const requestProposal = async (
    _toolCallId: string,
    proposal: ProposalRequest,
  ): Promise<boolean | string> => {
    if (proposal.kind === "question") {
      outcome.asked = true;
      outcome.questions.push(proposal.payload.question ?? "");
      // 回真答案，让 run 能正常收尾——我们要看的是「问不问」，不是问完怎样。
      return testCase.answer;
    }
    // 写操作一律拒：评测跑在用户真实 vault 上，绝不能落任何改动。
    return false;
  };

  harness = new AgentHarness({
    env: new NodeExecutionEnv({ cwd: vaultPath }),
    session: new Session(new InMemorySessionStorage()),
    models,
    model,
    thinkingLevel: "off",
    systemPrompt: buildSystemPrompt(request, entry, entry ? resolveDialect({ kind: entry.kind, displayName: entry.kind }) : null),
    tools: createAgentTools({
      ctx: buildToolContext(world, request.runId, settings),
      requestProposal,
    }),
  });

  const unsubscribe = harness.subscribe((event) => {
    if (event.type === "tool_execution_start") {
      outcome.toolCalls.push(event.toolName);
      const args = JSON.stringify(event.args ?? {});
      if (event.toolName === "get_table_schema" || event.toolName === "run_sql") {
        outcome.tablesTouched.push(...bareTablesIn(args));
      }
      if (outcome.toolCalls.length > MAX_TOOL_CALLS) stop("tool call cap");
    }
  });

  const started = Date.now();
  try {
    const result = await harness.prompt(buildUserContent(request));
    outcome.finalText = assistantText(result);
    if (result.stopReason === "error") outcome.error ||= result.errorMessage ?? "agent error";
  } catch (err) {
    outcome.error ||= err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(timer);
    unsubscribe();
    outcome.elapsedMs = Date.now() - started;
  }
  return outcome;
}

function pct(part: number, whole: number): number {
  return whole === 0 ? 0 : part / whole;
}

function mentionsAssumption(text: string): boolean {
  return /假设|口径|我选(择|用)了|assumption/i.test(text);
}

/**
 * 不烧 token 的自检：模型之外的一切都在这里跑一遍。
 * 三处替身和 proposal 拦截是最容易静默坏掉的地方——payload 字段改个名，
 * 整轮评测会安静地报「一次都没问」。
 */
async function selfCheck(world: EvalWorld, sampleTable: string): Promise<void> {
  const settings = buildEvalSettings("self-check", "http://localhost");
  const asked: string[] = [];
  const ctx = {
    ...buildToolContext(world, "self-check", settings),
    requestProposal: async (proposal: ProposalRequest): Promise<boolean | string> => {
      if (proposal.kind !== "question") return false;
      asked.push(proposal.payload.question ?? "");
      return "答案是 threed.foo";
    },
  };

  const assert = (label: string, condition: boolean, detail: string): void => {
    console.log(`  ${condition ? "PASS" : "FAIL"}  ${label}${condition ? "" : `  ← ${detail}`}`);
    if (!condition) process.exitCode = 1;
  };

  const question = await dispatchTool("ask_user", JSON.stringify({ question: "选哪张表？" }), ctx);
  assert(
    "ask_user 把答案回给模型",
    question.ok && question.text.includes("threed.foo") && asked.length === 1,
    question.text,
  );

  const select = await dispatchTool(
    "run_sql",
    JSON.stringify({ sql: `SELECT count(1) FROM ${sampleTable}` }),
    ctx,
  );
  assert("run_sql 拿到替身结果", select.ok && select.text.includes(String(FAKE_ROW_COUNT)), select.text);

  const mutation = await dispatchTool("run_sql", JSON.stringify({ sql: "DELETE FROM t" }), ctx);
  assert("写操作被拒（评测绝不落改动）", !mutation.ok, mutation.text);

  const usage = await dispatchTool(
    "search_sql_usage",
    JSON.stringify({ readTable: sampleTable }),
    ctx,
  );
  assert("search_sql_usage 由语料回答", usage.ok && usage.text.includes(".md"), usage.text);

  const tables = await dispatchTool("search_tables", JSON.stringify({ keywords: "dataset" }), ctx);
  assert("search_tables 走真实 schema 检索", tables.ok && tables.text.length > 40, tables.text);
}

async function dryRun(cases: AskCase[], catalog: string[], blocks: number): Promise<void> {
  console.log(`\ndry run  [${cases.length / 2} pairs, ${catalog.length} tables, ${blocks} runsql blocks]\n`);
  for (const testCase of cases.filter((c) => c.kind === "ambiguous")) {
    console.log(`  ${testCase.prompt}`);
    console.log(`      candidates ${testCase.family.members.length} (${testCase.family.used.length} used):`);
    for (const member of testCase.family.members) {
      const mark = testCase.family.used.includes(member) ? "used" : "    ";
      console.log(`        ${mark}  ${member}`);
    }
    console.log(`      clear version: 帮我数一下 ${testCase.answer} 这张表现在有多少行。\n`);
  }
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const numeric = (flag: string): number | undefined => {
    for (const arg of args) {
      if (arg.startsWith(`${flag}=`)) {
        const value = Number(arg.slice(flag.length + 1));
        if (Number.isFinite(value)) return value;
      }
    }
    return undefined;
  };

  const pairs = Math.max(1, numeric("--pairs") ?? DEFAULT_PAIRS);
  const vaultPath = resolveVaultPath();
  process.stdout.write(`loading corpus from ${vaultPath} ... `);
  const corpus = await loadCorpus(vaultPath);
  const connection = await loadConnection(vaultPath);
  const catalog = await loadTableCatalog(connection);
  console.log(`${corpus.notes.length} notes, ${corpus.blocks.length} blocks, ${catalog.length} tables`);

  const used = new Set<string>();
  for (const block of corpus.blocks) {
    for (const table of [...block.readTables, ...block.writeTables]) used.add(table.toLowerCase());
  }
  const families = buildFamilies(catalog, used);
  const cases = buildCases(families, pairs);
  if (cases.length === 0) {
    throw new Error(
      `no ambiguous table families found in this vault ` +
        `(need ${MIN_FAMILY_SIZE}+ same-family tables with ${MIN_USED_IN_FAMILY}+ actually used)`,
    );
  }

  const world: EvalWorld = { vaultPath, connection, catalog, blocks: corpus.blocks };

  if (args.has("--dry-run")) {
    await dryRun(cases, catalog, corpus.blocks.length);
    return;
  }
  if (args.has("--self-check")) {
    console.log("\nself-check (no model calls)\n");
    await selfCheck(world, cases[0]!.answer);
    console.log("");
    return;
  }

  const credentials = requireCredentials();
  console.log(
    `model ${credentials.model}, ${cases.length / 2} pairs = ${cases.length} runs, ` +
      `connection ${connection?.name ?? "(none)"}\n`,
  );

  const outcomes = new Array<RunOutcome>(cases.length);
  const concurrency = Math.max(1, numeric("--concurrency") ?? 3);
  let next = 0;
  let done = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < cases.length; i = next++) {
      const testCase = cases[i]!;
      const outcome = await runOne(testCase, world, credentials);
      outcomes[i] = outcome;
      done++;
      const flag = outcome.asked ? "ASKED  " : "no ask ";
      console.log(
        `[${String(done).padStart(3)}/${cases.length}] ${flag} ${testCase.kind.padEnd(9)} ` +
          `${String(outcome.elapsedMs).padStart(6)} ms  ${outcome.toolCalls.length} calls  ` +
          `${testCase.family.stem}${outcome.error ? `  [${outcome.error}]` : ""}`,
      );
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, cases.length) }, worker));

  // 跑挂的 run 不参与打分：把 401 或超时当成「该问没问」，一次网络抖动
  // 就会看起来像提问判准退步。
  const scorable = (o: RunOutcome): boolean => o.asked || o.finalText.trim().length > 0;
  const paired = cases.map((c, i) => ({ c, o: outcomes[i]! })).filter((x) => scorable(x.o));
  const ambiguous = paired.filter((x) => x.c.kind === "ambiguous");
  const clear = paired.filter((x) => x.c.kind === "clear");
  const failures = outcomes.filter((o) => !scorable(o)).length;
  if (ambiguous.length === 0) {
    throw new Error(
      `every run failed (${outcomes.find((o) => o.error)?.error ?? "unknown"}). ` +
        "check STELA_EVAL_MODEL / _BASE_URL / _API_KEY.",
    );
  }
  const guessed = ambiguous.filter((x) => !x.o.asked);
  const askedAmbiguous = pct(ambiguous.filter((x) => x.o.asked).length, ambiguous.length);
  const askedClear = pct(clear.filter((x) => x.o.asked).length, clear.length);

  const report: Report = {
    generatedAt: new Date().toISOString(),
    model: credentials.model,
    pairs: ambiguous.length,
    askedWhenAmbiguous: askedAmbiguous,
    askedWhenClear: askedClear,
    askGap: askedAmbiguous - askedClear,
    silentGuessRate: pct(
      guessed.filter((x) => !mentionsAssumption(x.o.finalText)).length,
      ambiguous.length,
    ),
    assumptionStatedWhenGuessing: pct(
      guessed.filter((x) => mentionsAssumption(x.o.finalText)).length,
      guessed.length,
    ),
    avgToolCallsAmbiguous:
      ambiguous.reduce((sum, x) => sum + x.o.toolCalls.length, 0) / Math.max(1, ambiguous.length),
    avgToolCallsClear:
      clear.reduce((sum, x) => sum + x.o.toolCalls.length, 0) / Math.max(1, clear.length),
    failures,
  };

  const baselineFile = path.join(internalDir, "eval-agent-ask-baseline.json");
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
    `\nask discipline  [${ambiguous.length} ambiguous / ${clear.length} clear scored, ` +
      `model ${report.model}, ${failures} failed (excluded)]`,
  );
  console.log(
    `  asked when ambiguous  ${(report.askedWhenAmbiguous * 100).toFixed(1)}%${delta(report.askedWhenAmbiguous, baseline?.askedWhenAmbiguous)}  ← 越高越好`,
  );
  console.log(
    `  asked when clear      ${(report.askedWhenClear * 100).toFixed(1)}%${delta(report.askedWhenClear, baseline?.askedWhenClear)}  ← 越低越好`,
  );
  console.log(
    `  ask gap               ${(report.askGap * 100).toFixed(1)}pp${delta(report.askGap, baseline?.askGap)}  ← 单一头条指标`,
  );
  console.log(
    `  silent guess          ${(report.silentGuessRate * 100).toFixed(1)}%${delta(report.silentGuessRate, baseline?.silentGuessRate)}  猜了且没交代假设`,
  );
  console.log(
    `  assumption stated     ${(report.assumptionStatedWhenGuessing * 100).toFixed(1)}%  [${guessed.length} guessed]`,
  );
  console.log(
    `  avg tool calls        ${report.avgToolCallsAmbiguous.toFixed(1)} ambiguous / ${report.avgToolCallsClear.toFixed(1)} clear`,
  );
  // 别把百分比当精密仪器：报出粒度，一眼看出多少差异才算真的动了。
  console.log(`  granularity           ${(100 / report.pairs).toFixed(1)}pp per pair`);

  const questions = ambiguous.flatMap((x) => x.o.questions).filter(Boolean);
  if (questions.length > 0) {
    console.log(`\nquestions asked (${questions.length}):\n`);
    for (const question of questions.slice(0, 10)) console.log(`  ${question}`);
  }
  const silent = guessed.filter((x) => !mentionsAssumption(x.o.finalText));
  if (silent.length > 0) {
    console.log(`\nsilent guesses (${silent.length}):\n`);
    for (const x of silent.slice(0, 6)) {
      const picked = [...new Set(x.o.tablesTouched)].filter((t) =>
        x.c.family.members.some((m) => m.endsWith(`.${t}`)),
      );
      console.log(`  ${x.c.family.stem}  → picked ${picked.join(", ") || "(none)"}`);
    }
  }
  console.log("");

  if (args.has("--save")) {
    await fs.mkdir(internalDir, { recursive: true });
    await fs.writeFile(baselineFile, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
    console.log(`saved baseline -> ${path.relative(repoRoot, baselineFile)}`);
  }
}

// 只在被直接执行时跑：语料生成函数要能被别处 import 而不触发一整轮评测。
if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
