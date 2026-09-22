import assert from "node:assert/strict";
import { conversationResults, conversationTimeline } from "./conversation-timeline";
import type { ConversationTurn } from "@shared/conversation";
import type { RunRecord } from "@shared/types";
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
console.log("Conversation timeline: direct failure placement, repeated SQL tool results, and question lifecycle passed.");
