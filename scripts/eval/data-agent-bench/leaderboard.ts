/** Official 54-query scope: https://ucbepic.github.io/DataAgentBench/ */
export const LEADERBOARD_QUERIES: Readonly<Record<string, number>> = {
  agnews: 4, bookreview: 3, crmarenapro: 13, DEPS_DEV_V1: 2,
  GITHUB_REPOS: 4, googlelocal: 4, music_brainz_20k: 3,
  PANCANCER_ATLAS: 3, PATENTS: 3, stockindex: 3, stockmarket: 5, yelp: 7,
};

export function isLeaderboardCase(dataset: string, query: number): boolean {
  return Number.isInteger(query) && query >= 1 && query <= (LEADERBOARD_QUERIES[dataset] ?? 0);
}

export function leaderboardScore(rows: readonly { dataset: string; query: string; run: number; valid: boolean }[]) {
  const cases = new Map<string, Map<number, boolean>>();
  for (const row of rows) {
    if (!isLeaderboardCase(row.dataset, Number(row.query))) continue;
    const key = `${row.dataset}/${Number(row.query)}`;
    const trials = cases.get(key) ?? new Map<number, boolean>();
    if (trials.has(row.run)) throw new Error(`Duplicate DAB trial: ${key}/${row.run}`);
    trials.set(row.run, row.valid);
    cases.set(key, trials);
  }
  const byDataset = Object.fromEntries(Object.entries(LEADERBOARD_QUERIES).map(([dataset, count]) => {
    let sum = 0;
    for (let query = 1; query <= count; query++) {
      const trials = cases.get(`${dataset}/${query}`);
      sum += trials?.size ? [...trials.values()].filter(Boolean).length / trials.size : 0;
    }
    return [dataset, sum / count];
  }));
  const complete = cases.size === 54;
  return {
    // Partial runs never masquerade as a full leaderboard score.
    passAt1: complete ? Object.values(byDataset).reduce((a, b) => a + b, 0) / 12 : null,
    coveredQueries: cases.size,
    expectedQueries: 54,
    minimumTrialsPerQuery: complete ? Math.min(...[...cases.values()].map((v) => v.size)) : 0,
    hasRequiredTrials: complete && [...cases.values()].every((v) => v.size >= 5),
    byDataset,
  };
}
