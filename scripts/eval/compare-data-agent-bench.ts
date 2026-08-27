/**
 * Paired comparison of two Data Agent Bench result directories.
 *
 * A bench run of ~104 single-run cases has a binomial standard error near five
 * points, so an unpaired valid-rate difference of a few points says nothing. This
 * compares only the cases both runs completed, majority-votes repeated runs of the
 * same case, and reports McNemar's exact two-sided p for the discordant pairs.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface CaseOutcome {
  valid: boolean;
  runs: number;
  elapsedMs: number;
  toolCalls: number;
  outputTokens: number;
  planned: boolean;
  resultReviewStatus: string;
  error: string | null;
}

export interface PairedComparison {
  common: number;
  onlyInBaseline: number;
  onlyInCandidate: number;
  baselineValid: number;
  candidateValid: number;
  baselineOnlyCorrect: number;
  candidateOnlyCorrect: number;
  pValue: number;
  baselineMedianElapsedMs: number;
  candidateMedianElapsedMs: number;
  baselineMeanToolCalls: number;
  candidateMeanToolCalls: number;
  baselineMeanOutputTokens: number;
  candidateMeanOutputTokens: number;
  baselinePlannedCases: number;
  candidatePlannedCases: number;
  baselineErrors: Array<{ error: string; count: number }>;
  candidateErrors: Array<{ error: string; count: number }>;
  baselineReviewStatuses: Array<{ status: string; count: number }>;
  candidateReviewStatuses: Array<{ status: string; count: number }>;
}

/**
 * McNemar's exact two-sided p for `a` baseline-only and `b` candidate-only wins.
 * Exact rather than chi-square because the discordant count is routinely below 25.
 */
export function mcnemarExactP(a: number, b: number): number {
  const n = a + b;
  if (n === 0) return 1;
  let tail = 0;
  for (let i = 0; i <= Math.min(a, b); i += 1) {
    let term = 1;
    for (let k = 0; k < i; k += 1) term = (term * (n - k)) / (k + 1);
    tail += term;
  }
  return Math.min(1, (2 * tail) / 2 ** n);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function counted(values: string[]): Array<{ status: string; count: number }> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .map(([status, count]) => ({ status, count }))
    .sort((left, right) => right.count - left.count || left.status.localeCompare(right.status));
}

async function findFinalRuns(directory: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (current: string): Promise<void> => {
    const entries = await fs.readdir(current, { withFileTypes: true });
    await Promise.all(entries.map(async (entry) => {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile() && entry.name === "final_agent.json") files.push(target);
    }));
  };
  await visit(directory);
  return files.sort();
}

/** Majority vote repeated runs of one case; a tie counts as invalid. */
export async function readCaseOutcomes(directory: string): Promise<Map<string, CaseOutcome>> {
  const grouped = new Map<string, CaseOutcome[]>();
  for (const file of await findFinalRuns(directory)) {
    const raw = JSON.parse(await fs.readFile(file, "utf-8")) as Record<string, unknown>;
    const dataset = typeof raw.dataset === "string" ? raw.dataset : "";
    const query = raw.query === undefined ? "" : String(raw.query);
    if (!dataset || !query) continue;
    const counts = (raw.toolCallCounts ?? {}) as Record<string, number>;
    const usage = (raw.usage ?? {}) as Record<string, number>;
    const review = (raw.resultReview ?? {}) as Record<string, unknown>;
    const key = `${dataset}/query${query}`;
    grouped.set(key, [...(grouped.get(key) ?? []), {
      valid: raw.valid === true,
      runs: 1,
      elapsedMs: typeof raw.elapsedMs === "number" ? raw.elapsedMs : 0,
      toolCalls: typeof raw.toolCalls === "number" ? raw.toolCalls : 0,
      outputTokens: usage.outputTokens ?? 0,
      planned: (counts.create_plan ?? 0) > 0,
      resultReviewStatus: typeof review.status === "string" ? review.status : "legacy_unknown",
      error: typeof raw.error === "string" ? raw.error : null,
    }]);
  }
  const outcomes = new Map<string, CaseOutcome>();
  for (const [key, runs] of grouped) {
    const valid = runs.filter((run) => run.valid).length;
    outcomes.set(key, {
      valid: valid * 2 > runs.length,
      runs: runs.length,
      elapsedMs: median(runs.map((run) => run.elapsedMs)),
      toolCalls: mean(runs.map((run) => run.toolCalls)),
      outputTokens: mean(runs.map((run) => run.outputTokens)),
      planned: runs.some((run) => run.planned),
      resultReviewStatus: runs[0]?.resultReviewStatus ?? "legacy_unknown",
      error: runs.find((run) => run.error)?.error ?? null,
    });
  }
  return outcomes;
}

export function compareCaseOutcomes(
  baseline: Map<string, CaseOutcome>,
  candidate: Map<string, CaseOutcome>,
): PairedComparison {
  const common = [...baseline.keys()].filter((key) => candidate.has(key)).sort();
  const pairs = common.map((key) => ({ key, left: baseline.get(key)!, right: candidate.get(key)! }));
  const baselineOnlyCorrect = pairs.filter((pair) => pair.left.valid && !pair.right.valid).length;
  const candidateOnlyCorrect = pairs.filter((pair) => !pair.left.valid && pair.right.valid).length;
  const errorCounts = (side: "left" | "right"): Array<{ error: string; count: number }> =>
    counted(pairs.flatMap((pair) => pair[side].error ? [pair[side].error!.slice(0, 80)] : []))
      .map(({ status, count }) => ({ error: status, count }));
  return {
    common: common.length,
    onlyInBaseline: baseline.size - common.length,
    onlyInCandidate: candidate.size - common.length,
    baselineValid: pairs.filter((pair) => pair.left.valid).length,
    candidateValid: pairs.filter((pair) => pair.right.valid).length,
    baselineOnlyCorrect,
    candidateOnlyCorrect,
    pValue: mcnemarExactP(baselineOnlyCorrect, candidateOnlyCorrect),
    baselineMedianElapsedMs: median(pairs.map((pair) => pair.left.elapsedMs)),
    candidateMedianElapsedMs: median(pairs.map((pair) => pair.right.elapsedMs)),
    baselineMeanToolCalls: mean(pairs.map((pair) => pair.left.toolCalls)),
    candidateMeanToolCalls: mean(pairs.map((pair) => pair.right.toolCalls)),
    baselineMeanOutputTokens: mean(pairs.map((pair) => pair.left.outputTokens)),
    candidateMeanOutputTokens: mean(pairs.map((pair) => pair.right.outputTokens)),
    baselinePlannedCases: pairs.filter((pair) => pair.left.planned).length,
    candidatePlannedCases: pairs.filter((pair) => pair.right.planned).length,
    baselineErrors: errorCounts("left"),
    candidateErrors: errorCounts("right"),
    baselineReviewStatuses: counted(pairs.map((pair) => pair.left.resultReviewStatus)),
    candidateReviewStatuses: counted(pairs.map((pair) => pair.right.resultReviewStatus)),
  };
}

function report(baselineLabel: string, candidateLabel: string, result: PairedComparison): string {
  const rate = (valid: number): string =>
    `${valid}/${result.common} (${((valid / Math.max(1, result.common)) * 100).toFixed(1)}%)`;
  const minutes = (value: number): string => `${(value / 60_000).toFixed(1)} min`;
  const verdict = result.pValue < 0.05
    ? result.candidateOnlyCorrect > result.baselineOnlyCorrect ? "candidate wins" : "candidate regresses"
    : "indistinguishable";
  return [
    `baseline:  ${baselineLabel}`,
    `candidate: ${candidateLabel}`,
    "",
    `paired cases: ${result.common} (baseline-only ${result.onlyInBaseline}, candidate-only ${result.onlyInCandidate})`,
    `valid: baseline ${rate(result.baselineValid)} vs candidate ${rate(result.candidateValid)}`,
    `discordant: baseline-only ${result.baselineOnlyCorrect}, candidate-only ${result.candidateOnlyCorrect}`,
    `McNemar exact two-sided p: ${result.pValue.toFixed(3)} -> ${verdict}`,
    "",
    `median elapsed: ${minutes(result.baselineMedianElapsedMs)} -> ${minutes(result.candidateMedianElapsedMs)}`,
    `mean tool calls: ${result.baselineMeanToolCalls.toFixed(1)} -> ${result.candidateMeanToolCalls.toFixed(1)}`,
    `mean output tokens: ${Math.round(result.baselineMeanOutputTokens)} -> ${Math.round(result.candidateMeanOutputTokens)}`,
    `planned cases: ${result.baselinePlannedCases} -> ${result.candidatePlannedCases}`,
    "",
    "baseline result review: " + (result.baselineReviewStatuses.map((item) => `${item.status}=${item.count}`).join(" ") || "none"),
    "candidate result review: " + (result.candidateReviewStatuses.map((item) => `${item.status}=${item.count}`).join(" ") || "none"),
    "",
    "baseline errors:",
    ...(result.baselineErrors.length > 0
      ? result.baselineErrors.map((item) => `  ${item.count} ${item.error}`)
      : ["  none"]),
    "candidate errors:",
    ...(result.candidateErrors.length > 0
      ? result.candidateErrors.map((item) => `  ${item.count} ${item.error}`)
      : ["  none"]),
  ].join("\n");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const value = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const baselineValue = value("--baseline");
  const candidateValue = value("--candidate");
  if (!baselineValue || !candidateValue) {
    throw new Error("Pass --baseline <result directory> and --candidate <result directory>.");
  }
  const baseline = path.resolve(baselineValue);
  const candidate = path.resolve(candidateValue);
  const result = compareCaseOutcomes(
    await readCaseOutcomes(baseline),
    await readCaseOutcomes(candidate),
  );
  console.log(report(path.basename(baseline), path.basename(candidate), result));
  const json = value("--json");
  if (json) await fs.writeFile(path.resolve(json), `${JSON.stringify(result, null, 2)}\n`, "utf-8");
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
