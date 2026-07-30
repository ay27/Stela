import assert from "node:assert/strict";

import { ExecutionPlanStore, formatExecutionPlanEntry } from "./execution-plan";

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

assert.throws(
  () => store.update({ stepId: "trend", status: "running" }),
  /current step/,
);
assert.throws(
  () => store.update({ stepId: "scope", status: "completed" }),
  /evidence/,
);

const afterScope = store.update({
  stepId: "scope",
  status: "completed",
  evidence: "notes/metric-definition.md",
});
assert.equal(afterScope.steps[0]?.status, "completed");
assert.equal(afterScope.steps[1]?.status, "running");

const completed = store.update({
  stepId: "trend",
  status: "completed",
  evidence: "Daily aggregation returned 30 rows.",
  runId: "run_daily_trend",
});
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

console.log("execution plan tests passed.");
