import assert from "node:assert/strict";

import {
  createPlanPersistenceBuffer,
  ExecutionPlanStore,
  formatExecutionPlanEntry,
} from "./execution-plan";

const store = new ExecutionPlanStore("agent_test");

assert.throws(
  () => store.update({ stepId: "scope", status: "completed", evidence: "No plan yet." }),
  /Create a plan before updating it/,
);

const snapshot = store.create([
  {
    id: "scope",
    title: "Confirm the metric definition",
    intent: "Find the business definition before querying.",
    acceptance: "The definition source is identified.",
  },
  {
    id: "trend",
    title: "Query the daily trend",
    intent: "Measure the metric over time.",
    acceptance: "A daily result is available.",
  },
]);
assert.equal(snapshot.steps[0]?.status, "running");
assert.equal(snapshot.steps[1]?.status, "pending");

// Bookkeeping never fails the run: an unknown step is reported, not thrown.
const unknown = store.update({ stepId: "nope", status: "completed", evidence: "x" });
assert.equal(unknown.snapshot.version, 1);
assert.match(unknown.note ?? "", /Unknown plan step 'nope'/);

// Evidence is optional, and completing a step advances the running marker.
const afterScope = store.update({ stepId: "scope", status: "completed" });
assert.equal(afterScope.note, undefined);
assert.equal(afterScope.snapshot.steps[0]?.status, "completed");
assert.equal(afterScope.snapshot.steps[1]?.status, "running");

// Overwriting a terminal step is allowed, but it says so.
assert.match(
  store.update({ stepId: "scope", status: "skipped" }).note ?? "",
  /already completed/,
);

const completed = store.update({
  stepId: "trend",
  status: "completed",
  evidence: "Daily aggregation returned 30 rows.",
  runId: "run_daily_trend",
}).snapshot;
assert.equal(completed.steps[1]?.status, "completed");
assert.equal(completed.steps[1]?.runId, "run_daily_trend");

// Session 条目持有同一份可变计划；工具调用后重建上下文会读到最新快照。
{
  const plan = new ExecutionPlanStore("agent_session");
  plan.create([
    {
      id: "scope",
      title: "Confirm scope",
      intent: "Identify the requested metric.",
      acceptance: "The metric is defined.",
    },
  ]);
  assert.match(formatExecutionPlanEntry({ plan }), /\[running\] Confirm scope/);
}

// 持久化 JSONL 恢复后的 plain snapshot 也必须能投影进 Agent context。
assert.match(
  formatExecutionPlanEntry({ plan: JSON.parse(JSON.stringify(completed)) }),
  /\[completed\] Query the daily trend/,
);

// Plan entries must be deferred until the harness emits turn_end, after every
// toolResult from the current assistant tool-call batch has been persisted.
{
  const persisted: number[] = [];
  const buffer = createPlanPersistenceBuffer(async (value) => {
    persisted.push(value.version);
  });
  await buffer.enqueue(snapshot);
  await buffer.enqueue(completed);
  assert.deepEqual(persisted, []);
  await buffer.flush();
  assert.deepEqual(persisted, [1, 4]);
  await buffer.flush();
  assert.deepEqual(persisted, [1, 4]);
}

console.log("execution plan tests passed.");
