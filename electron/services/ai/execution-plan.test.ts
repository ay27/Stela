import assert from "node:assert/strict";

import {
  createPlanPersistenceBuffer,
  analysisReadinessIssues,
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
], {
  question: "What is the daily metric trend?",
  unresolved: ["Which source defines the metric?"],
});
assert.equal(snapshot.steps[0]?.status, "running");
assert.equal(snapshot.steps[1]?.status, "pending");
assert.match(analysisReadinessIssues(snapshot).join("; "), /grain is missing/);

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
  analysis: {
    question: "What is the daily metric trend?",
    grain: "one row per calendar day",
    measure: "SUM(facts.value)",
    dimensions: ["facts.day"],
    filters: ["facts.status = 'valid'"],
    sources: [{ table: "facts", columns: ["day", "value", "status"], reason: "Authoritative metric facts." }],
    joins: [],
    outputShape: "table",
    assumptions: [],
    unresolved: [],
    verificationChecks: [{ id: "row-count", description: "Check one output row per day." }],
  },
});
assert.equal(afterScope.steps[0]?.status, "completed");
assert.equal(afterScope.steps[1]?.status, "running");
assert.deepEqual(analysisReadinessIssues(afterScope), []);
assert.match(formatExecutionPlanEntry({ plan: afterScope }), /Analysis semantics/);

const completed = store.update({
  stepId: "trend",
  status: "completed",
  evidence: "Daily aggregation returned 30 rows.",
  runId: "run_daily_trend",
});
assert.equal(completed.steps[1]?.status, "completed");
assert.equal(completed.steps[1]?.runId, "run_daily_trend");

assert.throws(() => new ExecutionPlanStore("duplicate-checks").create([
  { id: "one", title: "One", intent: "Inspect", acceptance: "Known" },
], {
  verificationChecks: [
    { id: "same", description: "First" },
    { id: "same", description: "Second" },
  ],
}), /Duplicate verification check id/);

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
  await buffer.enqueue(afterScope);
  assert.deepEqual(persisted, []);
  await buffer.flush();
  assert.deepEqual(persisted, [1, 2]);
  await buffer.flush();
  assert.deepEqual(persisted, [1, 2]);
}

console.log("execution plan tests passed.");
