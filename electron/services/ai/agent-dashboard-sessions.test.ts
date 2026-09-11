import assert from "node:assert/strict";
import { app } from "electron";
import { mkdtemp, mkdir, readFile, writeFile, rename, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationDocument, ConversationTurn } from "@shared/conversation";
import { listDashboardSessions, loadDashboardSession } from "./agent-dashboard-sessions";
import { openLocalAgentSessionStorage, appendAgentHistoryStarted, appendAgentHistoryFinished } from "./agent-history";
import * as metrics from "./agent-metrics";
import { IPC } from "@shared/ipc-channels";
import { parseInput } from "@shared/ipc-schema";

async function main() {
  const root = await mkdtemp(join(tmpdir(), "stela-dashboard-sessions-"));
  app.setPath("userData", join(root, "user"));
  await app.whenReady();
  const vault = join(root, "vault");
  await mkdir(join(vault, "nested"), { recursive: true });
  try {
    await metrics.open(vault);
    for (const device of ["local", "remote"]) {
      const storage = await openLocalAgentSessionStorage(vault, device, `${device}-session`);
      await appendAgentHistoryStarted(storage, { runId: `${device}-run`, sessionId: `${device}-session`, prompt: `${device} legacy` });
      await appendAgentHistoryFinished(storage, `${device}-run`);
    }
    const now = Date.now();
    const sql: ConversationTurn = { id: "sql-turn", input: "SELECT 42", connectionName: "fixture", startedAt: now,
      status: "completed", events: [], responses: [], runs: [{ runId: "query", blockId: "sql-turn", sql: "SELECT 42", status: "ok",
        message: null, startedAt: now, elapsedMs: 12, rowCount: 1, connectionName: "fixture", notePath: null }] };
    const agent: ConversationTurn = { id: "agent-turn", input: "Explain this result", connectionName: "fixture", startedAt: now + 1,
      status: "completed", runs: [], events: [{ type: "final", runId: "agent-turn", content: "The answer is 42." }],
      message: { version: 1, segments: [{ kind: "text", text: "Explain this result" }], resources: [] },
      responses: [{ runId: "agent-turn", callId: "question", approve: true, answer: "All rows" }] };
    const doc: ConversationDocument = { kind: "stela-conversation", version: 1, id: "chat-session", title: "Durable Chat",
      createdAt: now, updatedAt: now + 2, connectionName: "fixture", draft: "", sessionJsonl: "", turns: [sql, agent] };
    const file = join(vault, "nested", "sample.stela.chat");
    await writeFile(file, JSON.stringify(doc));
    await writeFile(join(vault, "empty.stela.chat"), JSON.stringify({ ...doc, turns: [] }));
    await writeFile(join(vault, "broken.stela.chat"), "{broken");
    await writeFile(join(vault, ".hidden.stela.chat"), JSON.stringify(doc));
    const outside = join(root, "outside.stela.chat");
    await writeFile(outside, JSON.stringify(doc));
    await symlink(outside, join(vault, "escape.stela.chat"));
    await symlink(join(vault, "nested"), join(vault, "loop"));

    const page = await listDashboardSessions(vault, "local");
    assert.equal(page.sessions.length, 2, "Local legacy plus nonempty Chat, excluding remote/hidden/symlink sources");
    assert.equal(page.warnings.length, 1);
    assert.match(page.warnings[0]!, /broken.stela.chat/);
    const chat = page.sessions.find(item => "conversationPath" in item.ref)!;
    assert.equal(chat.title, doc.title);
    const before = await readFile(file, "utf8");
    const history = await loadDashboardSession(vault, "local", chat.ref);
    assert.deepEqual(history.runs.map(run => run.request.runId), [sql.id, agent.id]);
    assert.deepEqual(history.runs[1]!.request.message, agent.message);
    assert.deepEqual(history.runs[1]!.proposalResponses, agent.responses);
    assert.deepEqual(history.runs[0]!.conversation?.runs, sql.runs);
    assert.equal(history.runs[0]!.finishedAt, null, "Do not fabricate a completion timestamp");
    assert.equal(await readFile(file, "utf8"), before, "Inspection must not write");
    const legacy = page.sessions.find(item => "deviceSlug" in item.ref)!;
    assert.equal((await loadDashboardSession(vault, "local", legacy.ref)).runs[0]!.request.prompt, "local legacy");

    metrics.startRun({ runId: "agent:agent-turn", surface: "agent", operation: "chat", startedAt: now, request: { runId: agent.id } });
    metrics.addUsage("agent:agent-turn", { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 });
    metrics.finishRun("agent:agent-turn", { status: "completed" });
    const trace = metrics.getSessionTrace(history);
    assert.equal(trace.turns[0]!.trace, null, "SQL-only turn has no model trace");
    assert.equal(trace.turns[1]!.trace?.root.run.runId, "agent:agent-turn");
    assert.equal(trace.totals.turnCount, 2);
    assert.equal(trace.totals.promptTokens, 10);
    assert.equal(trace.totals.outputTokens, 5);
    metrics.clear();
    assert.equal(metrics.getSessionTrace(history).turns[1]!.trace, null);
    assert.equal(history.runs[1]!.events[0]!.type, "final", "Metric cleanup does not remove Chat content");

    await assert.rejects(() => loadDashboardSession(vault, "local", { conversationPath: file, sessionId: "wrong" }), /identity changed/);
    await assert.rejects(() => loadDashboardSession(vault, "local", { conversationPath: outside, sessionId: doc.id }));
    await assert.rejects(() => loadDashboardSession(vault, "local", { conversationPath: join(vault, "escape.stela.chat"), sessionId: doc.id }));
    await assert.rejects(() => loadDashboardSession(vault, "local", { conversationPath: join(vault, "nested", "..", "..", "outside.stela.chat"), sessionId: doc.id }));
    const interrupted = JSON.stringify({ ...doc, turns: [{ ...sql, status: "running" }] });
    await writeFile(file, interrupted);
    assert.equal((await loadDashboardSession(vault, "local", chat.ref)).runs[0]!.conversation?.status, "interrupted");
    assert.equal(await readFile(file, "utf8"), interrupted, "Stale running state is normalized only in memory");
    const moved = join(vault, "renamed.stela.chat");
    await rename(file, moved);
    const movedRef = (await listDashboardSessions(vault, "local")).sessions.find(item => item.sessionId === doc.id)!.ref;
    assert.deepEqual(movedRef, { conversationPath: await realpath(moved), sessionId: doc.id });
    assert.equal((await loadDashboardSession(vault, "local", movedRef)).runs.length, 1);
    await rm(moved);
    assert.equal((await listDashboardSessions(vault, "local")).sessions.length, 1);

    assert.deepEqual(parseInput(IPC.AI_METRICS_GET_SESSION_TRACE, chat.ref), chat.ref);
    assert.deepEqual(parseInput(IPC.AI_METRICS_GET_SESSION_TRACE, legacy.ref), legacy.ref);
    assert.throws(() => parseInput(IPC.AI_METRICS_GET_SESSION_TRACE, { ...chat.ref, deviceSlug: "local" }));
    assert.throws(() => parseInput(IPC.AI_METRICS_GET_SESSION_TRACE, { conversationPath: "", sessionId: doc.id }));
    assert.throws(() => parseInput(IPC.AI_METRICS_LIST_SESSIONS, { path: outside }));
    console.log("Dashboard sessions passed: legacy + Chat discovery, SQL-only turns, metric joins/expiry, messages/responses, warnings, rename/delete, read-only interruption, path and IPC boundaries.");
  } finally {
    metrics.__resetForTests();
    await rm(root, { recursive: true, force: true });
  }
}
void main().then(() => app.exit(0), error => { console.error(error); app.exit(1); });
