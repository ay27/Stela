import assert from 'node:assert/strict';
import { LEADERBOARD_QUERIES, leaderboardScore } from './leaderboard';
import { parseArgs, selectTasks } from '../run-data-agent-bench';

const tasks = Object.entries(LEADERBOARD_QUERIES).flatMap(([dataset, n]) =>
  Array.from({ length: n }, (_, i) => ({ dataset, queryId: i + 1, queryDir: `/unused/${dataset}/${i + 1}` })));
const extras = [...tasks, { dataset: 'imdb', queryId: 1, queryDir: '/unused/imdb/1' }];
const opts = parseArgs(['--dab-root', '/unused', '--all']);
assert.equal(opts.runs, 5);
assert.equal(selectTasks(extras, opts, null).length, 54);
assert.throws(() => selectTasks(tasks.slice(1), opts, null), /requires 54/);
const failed = { source: '/old', cases: [{ dataset: 'agnews', queryId: 3 }, { dataset: 'imdb', queryId: 1 }], keys: new Set(['agnews\u00003', 'imdb\u00001']) };
const repair = parseArgs(['--dab-root', '/unused', '--failed-from', '/old', '--runs', '1']);
assert.deepEqual(selectTasks(extras, repair, failed).map(t => t.dataset), ['agnews']);
const rows = tasks.flatMap(t => Array.from({ length: 5 }, (_, run) => ({ dataset: t.dataset, query: String(t.queryId), run, valid: t.dataset !== 'agnews' })));
const score = leaderboardScore(rows);
assert.equal(score.coveredQueries, 54);
assert.equal(score.hasRequiredTrials, true);
assert.equal(score.passAt1, 11 / 12);
assert.equal(leaderboardScore(rows.filter(r => r.dataset !== 'agnews')).passAt1, null);
assert.equal(leaderboardScore(rows.filter(r => r.run === 0)).hasRequiredTrials, false);
// Per-query means remain equally weighted even with unequal trial counts.
const uneven = [...rows, { dataset: 'agnews', query: '1', run: 5, valid: true }];
assert.ok(Math.abs(leaderboardScore(uneven).passAt1! - (11 + 1 / 6 / 4) / 12) < 1e-12);
assert.throws(() => leaderboardScore([...rows, rows[0]!]), /Duplicate/);
console.log('leaderboard scope and scoring tests passed');
