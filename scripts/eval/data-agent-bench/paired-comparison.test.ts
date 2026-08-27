import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  compareCaseOutcomes,
  mcnemarExactP,
  readCaseOutcomes,
} from "../compare-data-agent-bench";

// The exact test must reproduce the values the review of ADR-0075 relied on.
assert.equal(mcnemarExactP(0, 0), 1);
assert.equal(Number(mcnemarExactP(10, 7).toFixed(3)), 0.629);
assert.ok(mcnemarExactP(12, 1) < 0.01, "a lopsided split must be significant");
assert.ok(mcnemarExactP(6, 6) > 0.9, "a balanced split must not be significant");

const root = await fs.mkdtemp(path.join(os.tmpdir(), "stela-dab-compare-"));
try {
  const write = async (
    directory: string,
    dataset: string,
    query: number,
    run: number,
    body: Record<string, unknown>,
  ): Promise<void> => {
    const target = path.join(root, directory, `query_${dataset}`, `query${query}`, `run_${run}`);
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(
      path.join(target, "final_agent.json"),
      JSON.stringify({ dataset, query: String(query), run, elapsedMs: 1000, toolCalls: 5, ...body }),
      "utf-8",
    );
  };

  // Majority vote: two of three runs valid counts as one valid case.
  await write("baseline", "imdb", 1, 0, { valid: true });
  await write("baseline", "imdb", 1, 1, { valid: false });
  await write("baseline", "imdb", 1, 2, { valid: true });
  await write("candidate", "imdb", 1, 0, { valid: false });
  await write("candidate", "imdb", 1, 1, { valid: false });
  await write("candidate", "imdb", 1, 2, { valid: true });
  // Candidate-only win on a planned case, with the review status recorded.
  await write("baseline", "cve", 2, 0, {
    valid: false,
    error: "planned analysis did not pass finalize_analysis",
    toolCallCounts: { create_plan: 1 },
    resultReview: { status: "structural_failed" },
  });
  await write("candidate", "cve", 2, 0, {
    valid: true,
    toolCallCounts: { create_plan: 1 },
    resultReview: { status: "structural_only" },
  });
  // A case only the baseline completed must be excluded from the pair set.
  await write("baseline", "yelp", 3, 0, { valid: true });

  const baseline = await readCaseOutcomes(path.join(root, "baseline"));
  const candidate = await readCaseOutcomes(path.join(root, "candidate"));
  assert.equal(baseline.get("imdb/query1")?.runs, 3);
  assert.equal(baseline.get("imdb/query1")?.valid, true);
  assert.equal(candidate.get("imdb/query1")?.valid, false);

  const result = compareCaseOutcomes(baseline, candidate);
  assert.equal(result.common, 2);
  assert.equal(result.onlyInBaseline, 1);
  assert.equal(result.onlyInCandidate, 0);
  assert.equal(result.baselineValid, 1);
  assert.equal(result.candidateValid, 1);
  assert.equal(result.baselineOnlyCorrect, 1);
  assert.equal(result.candidateOnlyCorrect, 1);
  assert.equal(result.pValue, 1);
  assert.equal(result.baselinePlannedCases, 1);
  assert.equal(result.candidatePlannedCases, 1);
  assert.deepEqual(result.baselineErrors, [
    { error: "planned analysis did not pass finalize_analysis", count: 1 },
  ]);
  assert.deepEqual(result.candidateReviewStatuses, [
    { status: "legacy_unknown", count: 1 },
    { status: "structural_only", count: 1 },
  ]);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

console.log("paired comparison tests passed");
