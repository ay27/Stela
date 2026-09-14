import { pipelineAuthoringFixture } from "@shared/canvas-authoring.fixture";
import { withAgentResourceId } from "@shared/agent-message";
import assert from "node:assert/strict";
import { app } from "electron";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import * as conversation from "./conversation";
import { listDashboardSessions, loadDashboardSession } from "./ai/agent-dashboard-sessions";
import * as metrics from "./ai/agent-metrics";
import * as store from "./result-store";
import * as registry from "./connectors/registry";
import { pruneLocalAgentHistory, openLocalAgentSessionStorage, appendAgentHistoryStarted, appendAgentHistoryFinished } from "./ai/agent-history";
import { loadDeviceProfile } from "./device-profile";
import { patchAppSettings, getDefaultAppSettings } from "./settings-store";
import { saveApiKey } from "./ai/provider";
import type { IConversationSnapshot } from "@shared/conversation";

async function main() {
  const root = await mkdtemp(join(tmpdir(), "stela-conversation-test-"));
  app.setPath("userData", root);
  await app.whenReady();
  const vault = join(root, "vault"); await mkdir(vault);
  let modelCalls = 0; let phase = "final"; let step = 0; let savedId = "";
  const requests: unknown[] = [];
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body)); modelCalls++;
    const tool = step++ === 0 ? phase === "repair" ? { name: "run_query", arguments: JSON.stringify({ language: "sql", query: "SELECT 42 AS answer", connectionName: "fixture" }) }
      : phase === "clarify" ? { name: "ask_user", arguments: JSON.stringify({ question: "Which period?", options: ["Last month", "This month"] }) }
      : phase === "canvas" ? { name: "create_analysis_canvas", arguments: JSON.stringify({ canvas: pipelineAuthoringFixture, sourceRuns: [] }) }
      : phase === "existing" ? { name: "read_conversation_result", arguments: JSON.stringify({ runId: savedId, limit: 10 }) } : null : null;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (delta: unknown, finish: string | null) => res.write(`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    send({ role: "assistant" }, null);
    if (tool) { send({ tool_calls: [{ index: 0, id: `call_${modelCalls}`, type: "function", function: tool }] }, null); send({}, "tool_calls"); }
    else { send({ content: "Completed using the saved query evidence." }, null); send({}, "stop"); }
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const received = new Map<string, IConversationSnapshot>();
  const publish = (s: IConversationSnapshot) => received.set(s.path, s);
  const waitFor = async (file: string, predicate: (s: IConversationSnapshot) => boolean) => {
    for (let i = 0; i < 500; i++) {
      const s = received.get(file) ?? await conversation.readConversation(vault, file);
      if (s.persistenceError) throw new Error(s.persistenceError);
      if (predicate(s)) return s;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`Timed out: ${JSON.stringify(received.get(file)?.document.turns.at(-1))}`);
  };
  const send = async (s: IConversationSnapshot, input: string) => conversation.submitConversation(vault, { locale: "zh", path: s.path, etag: s.etag, input, connectionName: "fixture", requestId: randomUUID() }, publish);
  const done = (s: IConversationSnapshot) => s.document.turns.at(-1)?.status !== "running";
  try {
    await metrics.open(vault);
    const plugin = join(vault, ".stela/plugins/fixture"); await mkdir(plugin, { recursive: true });
    await writeFile(join(plugin, "plugin.json"), JSON.stringify({ id: "fixture", kind: "fixture", displayName: "Fixture", apiVersion: 1, entry: "index.cjs" }));
    await writeFile(join(plugin, "index.cjs"), `module.exports = { apiVersion: 1, create() { return {
      meta() { return { kind: 'fixture', displayName: 'Fixture', configSchema: {type:'object'}, defaultConfig: {}, subprocess:false }; },
      async execute(config, sql) { if (sql.includes('slow')) await new Promise(r => setTimeout(r,150)); if (sql.includes('broken')) throw new Error('Unknown column broken'); if (/^UPDATE/i.test(sql)) return {kind:'mutation', affectedRows:1, elapsedMs:1}; return {kind:'query',columns:[{name:'answer',typeName:'INTEGER'}],rows:[[42]],elapsedMs:1}; },
      async listDatabases(){return ['db'];}, async listTables(){return ['t'];}, async test(){return {ok:true};}, async dispose(){}
    }; }};`);
    await writeFile(join(vault, ".stela/connections.json"), JSON.stringify({ entries: { fixture: { kind: "fixture", config: {} } } }));
    await registry.setVault(vault); await store.open(vault);
    let s = await conversation.createConversation(vault, vault, "SQL chat");
    const original = s;
    s = await conversation.saveConversationDraft(vault, s.path, s.etag, "SELECT 42", "fixture");
    await assert.rejects(() => conversation.saveConversationDraft(vault, s.path, original.etag, "stale", null), /changed/);
    const request = { path: s.path, etag: s.etag, input: "SELECT 42", connectionName: "fixture", requestId: randomUUID() };
    await conversation.submitConversation(vault, request, publish);
    await conversation.submitConversation(vault, request, publish);
    s = await waitFor(s.path, done); assert.equal(s.document.turns.length, 1); assert.equal(modelCalls, 0); assert.equal(s.document.turns[0]!.status, "completed");
    savedId = s.document.turns[0]!.runs[0]!.runId;
    assert.deepEqual((await conversation.readConversationResult(vault, [savedId], savedId, 0, 10)).rows, [[42]]);
    await assert.rejects(() => conversation.readConversationResult(vault, [], savedId, 0, 10), /belong/);
    assert.equal((await conversation.readConversation(vault, s.path)).document.turns.length, 1);
    await send(s, "UPDATE t SET x=1"); s = await waitFor(s.path, done); assert.equal(s.document.turns.at(-1)!.status, "error"); assert.equal(modelCalls, 0);
    await patchAppSettings(vault, { ai: { agentAllowMutations: true } });
    await send(s, "UPDATE t SET x=2"); s = await waitFor(s.path, s => s.document.turns.at(-1)!.events.some(e => e.type === "proposal"));
    assert.equal((await loadDashboardSession(vault, "local", { conversationPath: s.path, sessionId: s.document.id })).runs.at(-1)!.conversation?.status, "running", "Live inspection must preserve an active turn");
    let turn = s.document.turns.at(-1)!; const proposal = turn.events.find(e => e.type === "proposal")!;
    assert.equal(proposal.type, "proposal"); if (proposal.type !== "proposal") throw new Error("missing proposal");
    assert.equal(turn.runs.length, 0);
    await conversation.respondConversation(vault, s.path, { runId: turn.id, callId: proposal.callId, approve: true });
    s = await waitFor(s.path, done); assert.equal(s.document.turns.at(-1)!.runs[0]!.status, "ok");
    await send(s, "SELECT slow"); assert.throws(() => conversation.assertConversationsIdle(vault), /finish/);
    await conversation.cancelConversation(vault, s.path); s = await waitFor(s.path, done); assert.equal(s.document.turns.at(-1)!.status, "cancelled");
    const profile = await loadDeviceProfile(); const defaults = getDefaultAppSettings();
    await patchAppSettings(vault, { ai: { providerMode: "openai-compatible", activeProfileId: defaults.ai.activeProfileId, profiles: [{ ...defaults.ai.profiles[0]!, baseUrl: `http://127.0.0.1:${port}/v1`, model: "fixture", reasoningEffort: "off", hasApiKey: true }], automaticSkillMaintenanceEnabled: false, agentMaxIterations: 5, agentWallClockMs: 10000 } });
    await saveApiKey(vault, profile.slug, defaults.ai.activeProfileId, "fixture-key");
    phase = "repair"; step = 0;
    await send(s, "SELECT broken FROM t"); s = await waitFor(s.path, done);
    assert.equal(s.document.turns.at(-1)!.status, "completed", JSON.stringify(s.document.turns.at(-1)));
    assert.deepEqual(s.document.turns.at(-1)!.runs.map(r => r.status), ["err", "ok"]);
    assert.ok(s.document.sessionJsonl.includes("SELECT broken"));
    assert.match(JSON.stringify(requests.at(-1)), /locale: zh/);
    phase = "canvas"; step = 0;
    await send(s, "请用流程图说明链路"); s = await waitFor(s.path, done);
    const canvasEvent = s.document.turns.at(-1)!.events.find(event => event.type === "canvas_updated");
    assert.ok(canvasEvent?.type === "canvas_updated", JSON.stringify(s.document.turns.at(-1)));
    const createdCanvas = JSON.parse(await readFile(join(vault, canvasEvent.path), "utf8"));
    assert.equal(createdCanvas.createdBySessionId, s.document.id);
    assert.equal(createdCanvas.sections[0].cards[0].nodes.length, 20);
    assert.equal(createdCanvas.sections[0].cards[0].edges.length, 20);
    phase = "existing"; step = 0;
    await send(s, "Continue analysing the previous result"); s = await waitFor(s.path, done);
    assert.equal(s.document.turns.at(-1)!.status, "completed"); assert.equal(s.document.turns.at(-1)!.runs.length, 0);
    assert.ok(s.document.turns.at(-1)!.events.some(e => e.type === "tool_result" && e.ok));
    assert.ok(!s.document.turns.at(-1)!.events.some(e => e.type === "tool_result" && !e.ok), JSON.stringify(s.document.turns.at(-1)));
    phase = "clarify"; step = 0;
    await send(s, "Compare revenue"); s = await waitFor(s.path, s => s.document.turns.at(-1)!.events.some(e => e.type === "proposal"));
    turn = s.document.turns.at(-1)!; const question = turn.events.find(e => e.type === "proposal");
    if (!question || question.type !== "proposal") throw new Error("missing question");
    await conversation.respondConversation(vault, s.path, { runId: turn.id, callId: question.callId, approve: true, answer: "Last month" });
    s = await waitFor(s.path, done); assert.equal(s.document.turns.at(-1)!.status, "completed");
    phase = "final"; step = 0;
    const ref = withAgentResourceId({ kind: "runsql", label: "Referenced SQL", sql: "SELECT reference_payload", sourcePath: "orders.md", locator: { blockIndex: 0 } });
    const structured = { version: 1 as const, segments: [{ kind: "text" as const, text: "SELECT 1\n" }, { kind: "resource" as const, resourceId: ref.id }], resources: [ref] };
    s = await conversation.saveConversationDraft(vault, s.path, s.etag, "legacy projection", "fixture", structured);
    assert.deepEqual((await conversation.readConversation(vault, s.path)).document.draftMessage, structured);
    const beforeReferences = modelCalls;
    await conversation.submitConversation(vault, { path: s.path, etag: s.etag, input: "SELECT 1", message: structured, connectionName: "fixture", requestId: randomUUID() }, publish);
    s = await waitFor(s.path, done);
    assert.ok(modelCalls > beforeReferences, "SQL with an explicit resource enters the Agent instead of bypassing it");
    assert.equal(s.document.turns.at(-1)!.runs.length, 0);
    assert.deepEqual(s.document.turns.at(-1)!.message, structured);
    assert.ok(JSON.stringify(requests.at(-1)).includes("reference_payload"), "full referenced SQL reaches the model");
    const fresh = await conversation.readConversation(vault, s.path); assert.equal(fresh.document.sessionJsonl, s.document.sessionJsonl);
    const dashboardSummary = (await listDashboardSessions(vault, profile.slug)).sessions.find(item => item.sessionId === fresh.document.id)!;
    assert.ok(dashboardSummary, "Executed Chat must be discoverable in Dashboard");
    const dashboard = metrics.getSessionTrace(await loadDashboardSession(vault, profile.slug, dashboardSummary.ref));
    assert.equal(dashboard.turns.length, fresh.document.turns.length);
    assert.equal(dashboard.turns[0]!.trace, null, "Direct SQL does not invent an Agent run");
    assert.ok(dashboard.turns.some(turn => turn.trace?.root.run.operation === "chat"), "Actual Chat Agent calls join their recorded metrics");
    for (let i = 0; i < 22; i++) {
      const history = await openLocalAgentSessionStorage(vault, profile.slug, `retention_${i}`);
      await appendAgentHistoryStarted(history, { runId: `retention_${i}`, sessionId: `retention_${i}`, prompt: "history fixture" });
      await appendAgentHistoryFinished(history, `retention_${i}`);
    }
    assert.equal((await pruneLocalAgentHistory(vault, profile.slug)).length, 2);
    assert.equal((await conversation.readConversation(vault, s.path)).document.sessionJsonl, fresh.document.sessionJsonl);

    // Temporary lifecycle: no empty file, recoverable drafts, explicit promotion and stable identity.
    let temporary = await conversation.createTemporaryConversation(vault, "Exploration");
    const temporaryPath = temporary.path;
    await assert.rejects(() => readFile(temporaryPath), /ENOENT/);
    temporary = await conversation.saveConversationDraft(vault, temporary.path, temporary.etag, "SELECT 42 AS answer", "fixture");
    assert.equal(JSON.parse(await readFile(temporary.path, "utf8")).draft, "SELECT 42 AS answer");
    await send(temporary, "SELECT slow");
    await assert.rejects(() => conversation.promoteConversation(vault, temporary.path, temporary.etag, "Chats", "Exploration"), /Finish/);
    temporary = await waitFor(temporary.path, done);
    const identity = temporary.document.id;
    await new Promise(resolve => setTimeout(resolve, 20));
    const promoted = await conversation.promoteConversation(vault, temporary.path, temporary.etag, "Chats", "Exploration");
    assert.equal(promoted.document.id, identity);
    assert.equal(promoted.temporary, false);
    assert.equal(promoted.previousPath, temporaryPath);
    await assert.rejects(() => readFile(temporaryPath), /ENOENT/);
    assert.equal((await conversation.readConversation(vault, temporaryPath)).path, promoted.path, "old live reference follows promotion");
    await send(promoted, "SELECT 42 AS answer");
    const continued = await waitFor(promoted.path, done);
    assert.equal(JSON.parse(await readFile(promoted.path, "utf8")).turns.length, 2);
    assert.equal(continued.document.id, identity);
    assert.equal((await listDashboardSessions(vault, profile.slug)).sessions.filter(item => item.sessionId === identity).length, 1);
    await assert.rejects(() => conversation.discardConversation(vault, promoted.path), /file tree/);
    const duplicate = await conversation.createTemporaryConversation(vault, "Duplicate");
    await assert.rejects(() => conversation.promoteConversation(vault, duplicate.path, duplicate.etag, "Chats", "Exploration"), /EEXIST/);
    assert.equal((await conversation.readConversation(vault, duplicate.path)).temporary, true);
    await conversation.discardConversation(vault, duplicate.path);
    await assert.rejects(() => conversation.readConversation(vault, duplicate.path), /ENOENT/);
    const imported = await conversation.importConversationHistory(vault, { deviceSlug: profile.slug, sessionId: "retention_21" });
    assert.equal(imported.document.turns[0]?.input, "history fixture");
    assert.ok(imported.document.sessionJsonl.length > 0);
    assert.equal((await conversation.importConversationHistory(vault, { deviceSlug: profile.slug, sessionId: "retention_21" })).path, imported.path);
    const protectedSession = await conversation.createTemporaryConversation(vault, "Protected");
    await conversation.saveConversationDraft(vault, protectedSession.path, protectedSession.etag, "draft", null);
    for (let i = 0; i < 22; i++) {
      const item = await conversation.createTemporaryConversation(vault, `Temporary ${i}`);
      await conversation.saveConversationDraft(vault, item.path, item.etag, "draft", null);
    }
    await conversation.protectConversations(vault, [protectedSession.path]);
    assert.ok((await conversation.listConversations(vault)).some(item => item.path === protectedSession.path));
    await conversation.protectConversations(vault, []);
    assert.equal((await conversation.listConversations(vault)).filter(item => item.temporary).length, 20);

    // Chat must dispatch the returned background job, and maintenance must remain on its own turn.
    await patchAppSettings(vault, { ai: { automaticSkillMaintenanceEnabled: true } });
    phase = "repair"; step = 0;
    let background = await conversation.createTemporaryConversation(vault, "Background");
    await send(background, "Inspect a value using tools");
    background = await waitFor(background.path, value => done(value) && value.document.turns[0].events.some(event => event.type === "skill_maintenance"));
    assert.ok(background.document.turns[0].events.some(event => event.type === "skill_maintenance" && event.outcome === "no_source"));
    for (const turn of background.document.turns) for (const event of turn.events) assert.equal(event.runId, turn.id);
    await patchAppSettings(vault, { ai: { automaticSkillMaintenanceEnabled: false } });
    // A conflict arriving while SQL is in flight preserves its received outcome
    // in a recovery document and does not overwrite the external edit.
    const conflict = await conversation.createConversation(vault, vault, "Conflict");
    await send(conflict, "SELECT slow");
    await waitFor(conflict.path, value => value.document.turns.at(-1)!.runs.some(run => run.status === "running"));
    const external = JSON.parse(await readFile(conflict.path, "utf8")); external.title = "external wins";
    await writeFile(conflict.path, JSON.stringify(external));
    for (let i = 0; i < 100 && !received.get(conflict.path)?.persistenceError; i++) await new Promise(resolve => setTimeout(resolve, 20));
    const error = received.get(conflict.path)?.persistenceError ?? "";
    const recoveryPath = /Recovery saved to (.+)$/.exec(error)?.[1];
    assert.ok(recoveryPath, error);
    const recovered = JSON.parse(await readFile(recoveryPath, "utf8"));
    assert.equal(recovered.turns[0].runs[0].status, "ok");
    assert.equal(recovered.turns[0].status, "interrupted");
    assert.equal(JSON.parse(await readFile(conflict.path, "utf8")).title, "external wins");

    const remote = JSON.parse(await readFile(s.path, "utf8")); remote.title = "external"; await writeFile(s.path, JSON.stringify(remote));
    await assert.rejects(() => conversation.saveConversationDraft(vault, s.path, s.etag, "do not overwrite", null), /changed/);
    const linked = join(vault, "escape.stela.chat"); const outside = join(root, "outside.stela.chat"); await writeFile(outside, "outside"); await symlink(outside, linked);
    await assert.rejects(() => conversation.readConversation(vault, linked));
    assert.ok(requests.length >= 6); console.log("Conversation integration: direct execution, deduplication, write gate, cancellation, automatic repair, saved-result follow-up, clarification, session persistence, conflict recovery, bounded-history independence and path confinement passed.");
  } finally {
    await conversation.stopAllConversations(); await registry.setVault(null); metrics.__resetForTests(); store.close(); server.close();
    await rm(root, { recursive: true, force: true });
  }
}
main().then(() => app.exit(0), error => { console.error(error); app.exit(1); });
