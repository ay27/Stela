import assert from "node:assert/strict";
import { conversationResults, conversationTimeline, conversationResultPrivacy } from "./conversation-timeline";
import type { ConversationTurn } from "@shared/conversation";
import type { RunRecord } from "@shared/types";
import { restorePrivacyText } from '@shared/ai-privacy';
const run = (runId: string, direct = false): RunRecord => ({ runId, blockId: direct ? "turn" : "agent:turn", sql: "SELECT 1", status: "ok", message: null, startedAt: 1, elapsedMs: 1, rowCount: 1, connectionName: "demo", notePath: "chat.stela.chat" });
const turn: ConversationTurn = { id: "turn", input: "SELECT 1", connectionName: "demo", startedAt: 1, status: "running", runs: [run("direct", true), run("query-1"), run("query-2")], responses: [], events: [] };
const results = conversationResults(turn, [
  { kind: "tool", id: "one", callId: "c1", name: "run_query", args: { sql: "SELECT 1" }, result: { ok: true, summary: '{"runId":"query-1"}' } },
  { kind: "progress", id: "p", runId: "turn", stepIndex: 0, content: "Checking again", phase: "completed" },
  { kind: "tool", id: "two", callId: "c2", name: "run_query", args: { sql: "SELECT 1" }, result: { ok: true, summary: '{"runId":"query-2"}' } },
]);
assert.deepEqual(results.before.map(r => r.runId), ["direct"]);
assert.deepEqual(results.byEntry.get("one")?.map(r => r.runId), ["query-1"]);
assert.deepEqual(results.byEntry.get("two")?.map(r => r.runId), ["query-2"]);
assert.equal(results.after.length, 0);
turn.events.push({ type: "proposal", runId: "turn", callId: "question", kind: "question", approvalMode: "manual", payload: { description: "Clarify period", question: "Which period?" } });
assert.equal(conversationTimeline(turn).find(e => e.kind === "proposal")?.resolution, "pending");
turn.responses.push({ runId: "turn", callId: "question", approve: true, answer: "This month" });
assert.equal(conversationTimeline(turn).find(e => e.kind === "proposal")?.resolution, "approved");
turn.responses = []; turn.status = "interrupted";
assert.equal(conversationTimeline(turn).find(e => e.kind === "proposal")?.resolution, "expired");
const privacy = { enabled: true, annotations: [{ token: 'PII_4CF', original: '1001DESIGN' }] };
turn.events.push(
  { type: 'final', runId: turn.id, content: '## PII_4CF 数据分布', privacy },
  { type: 'skill_maintenance_started', runId: turn.id, privacy: { enabled: true, annotations: [] } },
  { type: 'skill_maintenance', runId: turn.id, outcome: 'unchanged', actions: [], summary: 'No changes', privacy: { enabled: true, annotations: [] } },
);
const final = conversationTimeline(turn).find(entry => entry.kind === 'final');
assert(final?.kind === 'final');
assert.deepEqual(final.privacy, privacy, 'post-reply metadata must not erase final restoration annotations');
assert.equal(restorePrivacyText(final.content, final.privacy!.annotations), '## 1001DESIGN 数据分布');
turn.events.push(
  { type: 'tool_call', runId: turn.id, call: { callId: 'private-query', name: 'run_query', arguments: { sql: "select * from t where project='PII_4CF'" } }, privacy },
  { type: 'tool_result', runId: turn.id, callId: 'private-query', ok: true, summary: 'PII_ABC', privacy: { enabled: true, annotations: [{ token: 'PII_ABC', original: 'a name' }] } },
);
const tool = conversationTimeline(turn).find(entry => entry.kind === 'tool' && entry.callId === 'private-query');
assert.deepEqual(tool?.privacy?.annotations, [...privacy.annotations, { token: 'PII_ABC', original: 'a name' }], 'tool results keep both argument and result annotations');
assert.equal(conversationResultPrivacy(turn).size, 0, 'legacy and direct results have no inferred marker');
turn.events.push({ type: 'tool_result', runId: turn.id, callId: 'masked', ok: true, summary: '', privacy: { enabled: true, annotations: [], results: [{ runId: 'source', columns: [{ column: 0, state: 'masked' }] }, { runId: 'other', columns: [{ column: 0, state: 'masked' }] }] } });
turn.events.push({ type: 'tool_result', runId: turn.id, callId: 'release', ok: true, summary: '', privacy: { enabled: true, annotations: [], results: [{ runId: 'source', columns: [{ column: 0, state: 'released' }] }] } });
assert.equal(conversationResultPrivacy(turn).get('source')!.columns[0]!.state, 'released');
assert.equal(conversationResultPrivacy(turn).get('other')!.columns[0]!.state, 'masked');
console.log("Conversation timeline: direct failure placement, repeated SQL tool results, and question lifecycle passed.");
