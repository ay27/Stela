/**
 * 检索评测入口。不需要 API key、不需要 Electron、不烧 token。
 *
 *   STELA_EVAL_VAULT=~/some-vault npx tsx scripts/eval/run-retrieval.ts
 *   npx tsx scripts/eval/run-retrieval.ts --fixture      # 用合成 fixture vault
 *   npx tsx scripts/eval/run-retrieval.ts --save         # 写 baseline
 *   npx tsx scripts/eval/run-retrieval.ts --compare      # 与 baseline 对比
 *
 * 测三件事：
 *   M1  表标识符 → 笔记      走 search.searchVault
 *   M2  中文 heading → 表    走 ai/schema-context.searchTables
 *   M3  负例                 两条路都不该给出高分命中
 *
 * baseline 落 `scripts/internal/`（已 gitignore），不进公开仓库。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ConnectionEntry, ConnectionMap } from "@shared/types";

import { searchVaultNotes } from "../../electron/services/search";
import { searchTables } from "../../electron/services/ai/schema-context";
import {
  buildLabels,
  loadCorpus,
  resolveVaultPath,
  type Corpus,
  type Labels,
} from "./corpus";
import { materializeFixture } from "./fixture";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const internalDir = path.join(repoRoot, "scripts", "internal");

/** agent 的默认值（agent-tools.ts runSearchVault / runSearchTables）。 */
const AGENT_VAULT_MAX_NOTES = 40;
const AGENT_TABLE_LIMIT = 10;
/** 排名指标要看到 top-20，所以表检索按 20 取，笔记检索仍按 agent 的真实预算。 */
const TABLE_EVAL_LIMIT = 20;

interface RankMetrics {
  cases: number;
  recallAt5: number;
  recallAt20: number;
  mrr: number;
  /** gold 完全没出现在返回结果里的比例——这是「任意截断」最直接的体现 */
  missRate: number;
}

interface Report {
  generatedAt: string;
  corpus: {
    label: string;
    notes: number;
    runsqlBlocks: number;
    distinctTables: number;
    bodyBytes: number;
  };
  m1: RankMetrics & { elapsedMs: number };
  m2: RankMetrics & { elapsedMs: number };
  m3: {
    cases: number;
    vaultFalsePositiveRate: number;
    tableFalsePositiveRate: number;
  };
}

function recallAt(ranked: string[], gold: Set<string>, k: number): number {
  if (gold.size === 0) return 1;
  let found = 0;
  for (const item of ranked.slice(0, k)) {
    if (gold.has(item)) found++;
  }
  return found / gold.size;
}

function reciprocalRank(ranked: string[], gold: Set<string>): number {
  for (let i = 0; i < ranked.length; i++) {
    if (gold.has(ranked[i]!)) return 1 / (i + 1);
  }
  return 0;
}

function summarize(
  results: Array<{ ranked: string[]; gold: Set<string> }>,
): RankMetrics {
  if (results.length === 0) {
    return { cases: 0, recallAt5: 0, recallAt20: 0, mrr: 0, missRate: 0 };
  }
  let r5 = 0;
  let r20 = 0;
  let mrr = 0;
  let misses = 0;
  for (const { ranked, gold } of results) {
    r5 += recallAt(ranked, gold, 5);
    r20 += recallAt(ranked, gold, 20);
    const rr = reciprocalRank(ranked, gold);
    mrr += rr;
    if (rr === 0) misses++;
  }
  const n = results.length;
  return {
    cases: n,
    recallAt5: r5 / n,
    recallAt20: r20 / n,
    mrr: mrr / n,
    missRate: misses / n,
  };
}

/**
 * 归一成「有序、去重的笔记相对路径列表」。返回值可能是绝对路径（行级 API）
 * 也可能已是相对路径（笔记级 API），两种都吃，保证跨 slice 指标可比。
 */
function toNoteRanking(
  hits: Array<{ path: string }>,
  vaultPath: string,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const hit of hits) {
    const rel = (
      path.isAbsolute(hit.path) ? path.relative(vaultPath, hit.path) : hit.path
    ).replace(/\\/g, "/");
    if (seen.has(rel)) continue;
    seen.add(rel);
    out.push(rel);
  }
  return out;
}

async function loadConnection(
  vaultPath: string,
): Promise<{ name: string; entry: ConnectionEntry } | null> {
  const configPath = path.join(vaultPath, ".stela", "connections.json");
  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf-8");
  } catch {
    return null;
  }
  let parsed: { entries?: ConnectionMap };
  try {
    parsed = JSON.parse(raw) as { entries?: ConnectionMap };
  } catch {
    return null;
  }
  const entries = Object.entries(parsed.entries ?? {});
  if (entries.length === 0) return null;
  // 优先带 schemaDir 的连接：没有 schemaDir 的话 searchTables 会去打真实 connector。
  const withSchemaDir = entries.find(([, entry]) => Boolean(entry.schemaDir));
  const [name, entry] = withSchemaDir ?? entries[0]!;
  return { name, entry };
}

async function evalM1(labels: Labels, vaultPath: string) {
  const started = Date.now();
  const results: Array<{ ranked: string[]; gold: Set<string> }> = [];
  for (const testCase of labels.m1TableToNotes) {
    const result = await searchVaultNotes(vaultPath, [testCase.query], {
      maxNotes: AGENT_VAULT_MAX_NOTES,
    });
    results.push({
      ranked: toNoteRanking(result.notes, vaultPath),
      gold: new Set(testCase.goldNotes),
    });
  }
  return { ...summarize(results), elapsedMs: Date.now() - started };
}

async function evalM2(
  labels: Labels,
  connection: { name: string; entry: ConnectionEntry } | null,
) {
  const started = Date.now();
  if (!connection) {
    return { ...summarize([]), elapsedMs: 0 };
  }
  const results: Array<{ ranked: string[]; gold: Set<string> }> = [];
  for (const testCase of labels.m2HeadingToTables) {
    const targets = await searchTables({
      connectionName: connection.name,
      connection: connection.entry,
      keywords: [testCase.query],
      limit: TABLE_EVAL_LIMIT,
    });
    results.push({
      ranked: targets.map((t) => (t.table ?? "").toLowerCase()).filter(Boolean),
      gold: new Set(testCase.goldTables),
    });
  }
  return { ...summarize(results), elapsedMs: Date.now() - started };
}

async function evalM3(
  labels: Labels,
  vaultPath: string,
  connection: { name: string; entry: ConnectionEntry } | null,
) {
  let vaultFalsePositives = 0;
  let tableFalsePositives = 0;
  for (const query of labels.m3Negatives) {
    const result = await searchVaultNotes(vaultPath, [query], { maxNotes: 5 });
    if (result.notes.length > 0) vaultFalsePositives++;
    if (connection) {
      const targets = await searchTables({
        connectionName: connection.name,
        connection: connection.entry,
        keywords: [query],
        limit: AGENT_TABLE_LIMIT,
      });
      if (targets.length > 0) tableFalsePositives++;
    }
  }
  const n = Math.max(1, labels.m3Negatives.length);
  return {
    cases: labels.m3Negatives.length,
    vaultFalsePositiveRate: vaultFalsePositives / n,
    tableFalsePositiveRate: tableFalsePositives / n,
  };
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function printReport(report: Report, baseline: Report | null): void {
  const delta = (now: number, before: number | undefined): string => {
    if (before === undefined) return "";
    const diff = now - before;
    if (Math.abs(diff) < 0.0005) return "  (=)";
    return `  (${diff > 0 ? "+" : ""}${(diff * 100).toFixed(1)}pp)`;
  };

  console.log(`\ncorpus: ${report.corpus.label}`);
  console.log(
    `  ${report.corpus.notes} notes, ${report.corpus.runsqlBlocks} runsql blocks, ` +
      `${report.corpus.distinctTables} distinct tables, ` +
      `${(report.corpus.bodyBytes / 1048576).toFixed(1)} MB body`,
  );

  for (const [key, title] of [
    ["m1", "M1 table identifier -> notes (searchVaultNotes)"],
    ["m2", "M2 chinese heading -> tables (searchTables)"],
  ] as const) {
    const now = report[key];
    const before = baseline?.[key];
    console.log(`\n${title}  [${now.cases} cases, ${now.elapsedMs} ms]`);
    console.log(`  recall@5   ${pct(now.recallAt5)}${delta(now.recallAt5, before?.recallAt5)}`);
    console.log(`  recall@20  ${pct(now.recallAt20)}${delta(now.recallAt20, before?.recallAt20)}`);
    console.log(`  MRR        ${now.mrr.toFixed(3)}${delta(now.mrr, before?.mrr)}`);
    console.log(`  miss rate  ${pct(now.missRate)}${delta(now.missRate, before?.missRate)}`);
  }

  console.log(`\nM3 negatives  [${report.m3.cases} cases]`);
  console.log(
    `  vault false-positive  ${pct(report.m3.vaultFalsePositiveRate)}` +
      delta(report.m3.vaultFalsePositiveRate, baseline?.m3.vaultFalsePositiveRate),
  );
  console.log(
    `  table false-positive  ${pct(report.m3.tableFalsePositiveRate)}` +
      delta(report.m3.tableFalsePositiveRate, baseline?.m3.tableFalsePositiveRate),
  );
  console.log("");
}

async function readBaseline(file: string): Promise<Report | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf-8")) as Report;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const useFixture = args.has("--fixture");

  let vaultPath: string;
  let label: string;
  if (useFixture) {
    vaultPath = await materializeFixture();
    label = `fixture (${vaultPath})`;
  } else {
    vaultPath = resolveVaultPath();
    label = "real vault";
  }

  const corpus: Corpus = await loadCorpus(vaultPath);
  const labels = buildLabels(corpus);
  const connection = await loadConnection(vaultPath);
  if (!connection) {
    console.warn("no connection with schemaDir found; M2/M3-table will report 0 cases");
  }

  const report: Report = {
    generatedAt: new Date().toISOString(),
    corpus: {
      label,
      notes: corpus.notes.length,
      runsqlBlocks: corpus.blocks.length,
      distinctTables: corpus.tableToNotes.size,
      bodyBytes: corpus.notes.reduce((sum, n) => sum + n.body.length, 0),
    },
    m1: await evalM1(labels, vaultPath),
    m2: await evalM2(labels, connection),
    m3: await evalM3(labels, vaultPath, connection),
  };

  const suffix = useFixture ? "fixture" : "real";
  const baselineFile = path.join(internalDir, `eval-retrieval-baseline.${suffix}.json`);
  const baseline = args.has("--compare") ? await readBaseline(baselineFile) : null;
  printReport(report, baseline);

  if (args.has("--save")) {
    await fs.mkdir(internalDir, { recursive: true });
    await fs.writeFile(baselineFile, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
    await fs.writeFile(
      path.join(internalDir, `eval-labels.${suffix}.json`),
      `${JSON.stringify(labels, null, 2)}\n`,
      "utf-8",
    );
    console.log(`saved baseline -> ${path.relative(repoRoot, baselineFile)}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
