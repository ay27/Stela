import assert from "node:assert/strict";
import { SemanticExecution, validateExtractionSchema, parseSemanticJson } from "./semantic-execution";
import type { SemanticRequest } from "../../shared/semantic";

const request: SemanticRequest = { operation: "classify", instructions: "Classify the topic", labels: { sports: "sport" },
  records: [{ id: "0", data: { text: "football" } }, { id: "1", data: { text: "tennis" } }] };
const abort = new AbortController();
let calls = 0;
const agent = new SemanticExecution({ identity: "test", signal: abort.signal, authorize: async () => true,
  complete: async (_system, user) => {
    calls++;
    const pending = JSON.parse(user) as SemanticRequest;
    const records = calls === 1 ? pending.records.slice(0, 1) : pending.records;
    if (calls === 2) assert.deepEqual(pending.records.map((r) => r.id), ["1"], "successful rows are not retried");
    return { tokens: 40, text: JSON.stringify({ rows: records.map((r) => ({ id: r.id, status: "success", value: "sports", evidence: [r.data.text] })) }) };
  },
});
const first = await agent.execute(JSON.stringify(request));
assert.equal(calls, 2);
assert.equal(first.rows.filter((r) => r.status === "success").length, 2);
const second = await agent.execute(JSON.stringify(request));
assert.equal(calls, 2);
assert.equal(second.cached, 2);
assert.equal(second.usage.records, 2);
await agent.execute(JSON.stringify({ ...request, instructions: "Changed business definition" }));
assert.equal(calls, 3, "definition changes invalidate cache");

let sent = 0;
const limited = new SemanticExecution({ identity: "limited", signal: abort.signal,
  budget: { records: 1, requests: 1, tokens: 1000 }, authorize: async () => true,
  complete: async () => { sent++; throw new Error("must not send"); },
});
const exhausted = await limited.execute(JSON.stringify(request));
assert.equal(sent, 0);
assert.ok(exhausted.rows.every((r) => r.status === "unprocessed"));
const denied = new SemanticExecution({ identity: "deny", signal: abort.signal,
  authorize: async () => false, complete: async () => { throw new Error("must not send"); } });
await assert.rejects(denied.execute(JSON.stringify(request)), /not authorized/);

for (const invalid of [
  { value: "invented_label", evidence: ["football"] },
  { value: "sports", evidence: ["invented_quote"] },
  { value: "sports", evidence: [] },
]) {
  let attempts = 0;
  const runner = new SemanticExecution({ identity: "invalid", signal: abort.signal, authorize: async () => true,
    complete: async () => { attempts++; return { tokens: 10, text: JSON.stringify({ rows: [{ id: "0", status: "success", ...invalid }] }) }; } });
  const result = await runner.execute(JSON.stringify({ ...request, records: request.records.slice(0, 1) }));
  assert.equal(attempts, 3);
  assert.equal(result.rows[0]?.status, "failed");
}
assert.throws(() => validateExtractionSchema({ type: "object", properties: {}, pattern: ".*" }), /Unsupported/);
validateExtractionSchema({ type: "object", properties: { amount: { type: "number" }, facts: { type: "array", items: { type: "string" } } }, required: ["amount"] });

const cancelled = new AbortController();
cancelled.abort();
const cancelledAgent = new SemanticExecution({ identity: "abort", signal: cancelled.signal,
  authorize: async () => { throw new Error("must not authorize"); }, complete: async () => { throw new Error("must not send"); } });
await assert.rejects(cancelledAgent.execute(JSON.stringify(request)), /abort/i);

const concurrencyBudget = new SemanticExecution({ identity: "concurrency", signal: abort.signal,
  budget: { records: 100, requests: 1, tokens: 100000 }, authorize: async () => true,
  complete: async (_s, user) => {
    const r = JSON.parse(user).records[0];
    return { tokens: 10, text: JSON.stringify({ rows: [{ id: r.id, status: "unresolved", value: null, evidence: [] }] }) };
  } });
await Promise.all(Array.from({ length: 8 }, (_, i) => concurrencyBudget.execute(JSON.stringify({ ...request, records: [{ id: String(i), data: { text: String(i) } }] }))));
assert.equal(concurrencyBudget.usage.requests, 1, "parallel cells cannot overspend request budget");
for (const wrap of [(s: string) => s, (s: string) => `\n\u0060\u0060\u0060json\n${s}\n\u0060\u0060\u0060\n`]) {
  let calls = 0;
  const runner = new SemanticExecution({ identity: "fence", signal: abort.signal, authorize: async () => true,
    complete: async (_s, user) => { calls++; return { tokens: 10, text: wrap(JSON.stringify({ rows: (JSON.parse(user) as SemanticRequest).records.map((r) => ({ id: r.id, status: "success", value: "sports", evidence: [r.data.text] })) })) }; } });
  const result = await runner.execute(JSON.stringify(request));
  assert.equal(calls, 1, "valid fences never consume a repair inference");
  assert.ok(result.rows.every((r) => r.status === "success"));
}
assert.throws(() => parseSemanticJson('Here is JSON: {"rows":[]}'), SyntaxError);
assert.throws(() => parseSemanticJson('```json\n{"rows":[]}'), SyntaxError);
let rowRepairCalls = 0;
const rowRepair = new SemanticExecution({ identity: "row-repair", signal: abort.signal, authorize: async () => true,
  complete: async (system, user) => {
    rowRepairCalls++;
    const pending = JSON.parse(user) as SemanticRequest;
    if (rowRepairCalls > 1) {
      assert.deepEqual(pending.records.map((r) => r.id), ["1"]);
      assert.match(system, /missing or invalid rows/);
    }
    return { tokens: 20, text: JSON.stringify({ rows: pending.records.map((r) => ({ id: r.id,
      status: rowRepairCalls === 1 && r.id === "1" ? "invalid-status" : "success", value: "sports", evidence: [r.data.text] })) }) };
  } });
assert.ok((await rowRepair.execute(JSON.stringify(request))).rows.every((r) => r.status === "success"));
assert.equal(rowRepairCalls, 2);
let rejectedCalls = 0;
const preflight = new SemanticExecution({ identity: "preflight", signal: abort.signal, authorize: async () => true,
  complete: async () => { rejectedCalls++; throw new Error("must not infer"); } });
const planned = await preflight.execute(JSON.stringify({ ...request, phase: "preflight", totalRecords: 14860 }));
assert.equal(planned.control?.canStartFull, false);
assert.equal(planned.control?.requiredRecordsUpperBound, 14860);
assert.equal(preflight.usage.records, 0);
assert.equal(rejectedCalls, 0);
await assert.rejects(preflight.execute(JSON.stringify({ ...request, requiredFields: ["header"] })), /Missing required semantic input field: header/);
for (const code of ["Provider finish_reason: sensitive", "quota exhausted"]) {
  let n = 0;
  const blocked = new SemanticExecution({ identity: code, signal: abort.signal, authorize: async () => true,
    complete: async () => { n++; throw new Error(code); } });
  const result = await blocked.execute(JSON.stringify(request));
  assert.equal(n, 1);
  assert.ok(result.rows.every((r) => r.status === "failed"));
}
console.log("semantic execution tests passed: protocol, row repair, evidence, preflight, budgets and terminal errors");
