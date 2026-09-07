/** Real tool -> Python -> job broker -> semantic service -> provider transport.
 * Only the desktop IPC carrier and remote HTTP response are simulated. No real
 * Vault, API key, database, model request or authorization grant is used. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AiProviderProfile, AiSettings, PythonExecutionRequest } from "../../../electron/shared/types";
import type { SemanticRequest } from "../../../electron/shared/semantic";
import { IPC_EVENTS } from "../../../electron/shared/ipc-events";
import { createAgentTools, dispatchTool, type AgentToolContext } from "../../../electron/services/ai/agent-tools";
import { loadAgentSkills } from "../../../electron/services/ai/agent-skills";
import { createSemanticAgent, clearSemanticWorkspace } from "../../../electron/services/ai/semantic-agent";
import { configureSemanticGrantRoot, revokeSemanticGrants } from "../../../electron/services/ai/semantic-grants";
import { saveApiKey } from "../../../electron/services/ai/provider";
import { executePython, resetPythonWorkspace, semanticForPythonJob, respondPythonRuntime,
  setPythonRuntimeBroadcaster, setPythonWorkspaceClearListener, cancelAllPythonRuntimeJobs, describePythonWorkspace } from "../../../electron/services/ai/python-runtime-broker";
import { createQueryArtifactTarget, finalizeMaterializedQueryArtifact, writeBufferedQueryArtifact,
  resolveQueryArtifact, discardQueryArtifactTarget } from "../../../electron/services/query-artifacts";
import { HeadlessPyodidePool } from "./headless-python";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "stela-semantic-workflow-"));
const pool = new HeadlessPyodidePool(path.resolve("node_modules/.cache/stela-pyodide"), 1);
const workspace = await pool.lease();
const sessionId = "synthetic-semantic-workflow";
setPythonWorkspaceClearListener(clearSemanticWorkspace);
const profile: AiProviderProfile = {
  id: "main", name: "Main fixture", vendorId: "custom", model: "main-fixture",
  baseUrl: "https://semantic-test.invalid/v1", contextWindow: 128_000,
  reasoningEffort: "off", hasApiKey: true,
};
const semanticProfile = { ...profile, id: "semantic", name: "Semantic fixture", model: "semantic-fixture" };
const settings: AiSettings = {
  profiles: [profile, semanticProfile], activeProfileId: profile.id, semanticProfileId: semanticProfile.id,
  providerMode: "openai-compatible", baseUrl: profile.baseUrl, model: profile.model,
  hasApiKey: true, contextWindow: 128_000, agentMaxIterations: 20, agentWallClockMs: 90_000,
  agentAllowMutations: false, agentAutoApplyEdits: false,
};
const jobs = new Map<string, AbortController>();
const carriers = new Set<Promise<void>>();
let latestJob = "";
setPythonRuntimeBroadcaster((channel, payload) => {
  if (channel === IPC_EVENTS.AI_PYTHON_RUNTIME_REQUEST) {
    const request = payload as PythonExecutionRequest;
    assert.equal(request.canSemantic, true);
    assert.deepEqual(request.inputs, [], "the synthetic workflow needs no source data");
    latestJob = request.jobId;
    const controller = new AbortController();
    jobs.set(request.jobId, controller);
    const carrier = workspace.execute({ vaultPath: root, sessionId, artifacts: {}, code: request.code,
      signal: controller.signal,
      runSemantic: (raw) => semanticForPythonJob({ jobId: request.jobId, request: raw }),
    }).then((result) => { respondPythonRuntime({ jobId: request.jobId, result }); }, (error: unknown) => {
      respondPythonRuntime({ jobId: request.jobId, result: {
        ok: false, stdout: "", value: { kind: "none" }, elapsedMs: 0,
        error: error instanceof Error ? error.message : String(error),
      } });
    }).finally(() => { jobs.delete(request.jobId); carriers.delete(carrier); });
    carriers.add(carrier);
  } else if (channel === IPC_EVENTS.AI_PYTHON_RUNTIME_CANCEL) {
    jobs.get((payload as { jobId: string }).jobId)?.abort();
  }
  return true;
});
const requests: Array<{ model: string; messages: Array<{ role: string; content: string }> }> = [];
let semanticRpcs = 0;
let holdProvider = false;
let providerEntered: (() => void) | undefined;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (_url, init) => {
  const payload = JSON.parse(String(init?.body)) as (typeof requests)[number];
  requests.push(payload);
  providerEntered?.();
  if (holdProvider) return new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    assert.ok(signal, "provider receives the composed cancellation signal");
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  const input = JSON.parse(payload.messages.find((m) => m.role === "user")!.content) as SemanticRequest;
  assert.doesNotMatch(JSON.stringify(input), /PRIVATE_COLUMN_MUST_NOT_LEAVE/, "only selected columns are transmitted");
  const rows = input.records.map((record) => {
    if (input.operation === "resolve") {
      const left = record.data.left as { name: string };
      return { id: record.id, status: "success", value: record.id === "0:2" ? "different" : "same", evidence: [left.name] };
    }
    const text = String(record.data.text);
    return { id: record.id, status: "success", evidence: [text], value:
      input.operation === "extract" ? { amount: 12 } : text.includes("football") ? "sports" : "business" };
  });
  const chunk = { id: "fixture-response", object: "chat.completion.chunk", created: 1, model: payload.model,
    choices: [{ index: 0, delta: { role: "assistant", content: "```json\n" + JSON.stringify({ rows }) + "\n```" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 20, completion_tokens: 20, total_tokens: 40 },
  };
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
};
let approvalMode: "allow" | "deny" | "wait" = "allow";
let approvalEntered: (() => void) | undefined;
let approvals = 0;
let progress = 0;
let usage = 0;
try {
  configureSemanticGrantRoot(path.join(root, "grants"));
  await saveApiKey(root, "fixture", profile.id, "offline-placeholder");
  await saveApiKey(root, "fixture", semanticProfile.id, "offline-placeholder");
  const skills = await loadAgentSkills(root, { systemSkillDir: path.resolve("resources/playbooks") });
  assert.ok(skills.system.some((s) => s.metadata.name === "semantic-analysis"));
  const startRun = (aiSettings = settings, controller = new AbortController()): AgentToolContext => {
    const semantic = createSemanticAgent({ vault: root, session: sessionId, slug: "fixture",
      settings: aiSettings, profile, signal: controller.signal, chinese: true,
      approve: async (description, allow, signal) => {
        approvals++;
        assert.match(description, /semantic-test.invalid/);
        assert.equal(allow, "允许批量发送");
        approvalEntered?.();
        if (approvalMode === "wait") await new Promise<void>((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        return approvalMode === "allow" ? allow : false;
      },
      onProgress: (_response, model) => { progress++; assert.ok([profile.model, semanticProfile.model].includes(model)); },
      onUsage: (value) => { usage += (value.input ?? 0) + (value.output ?? 0); },
    });
    return {
      vaultPath: root, connectionName: null, connection: null, aiSettings, signal: controller.signal,
      runSemantic: (raw, signal, wait) => { semanticRpcs++; return semantic.execute(raw, signal, wait); },
      pythonExecutor: { execute: executePython, reset: resetPythonWorkspace },
      queryArtifacts: { createTarget: createQueryArtifactTarget, finalize: finalizeMaterializedQueryArtifact,
        writeBuffered: writeBufferedQueryArtifact, resolve: resolveQueryArtifact, discard: discardQueryArtifactTarget },
      connector: { listKinds: () => [], listDatabases: async () => { throw new Error("No DB required"); },
        listTables: async () => { throw new Error("No DB required"); }, execute: async () => { throw new Error("No DB required"); } },
      sqlIndex: { query: async () => [] }, skills: skills.loaded, mode: "normal",
      run: { runId: `fixture-${requests.length}-${approvals}`, sessionId, notePath: null,
        questionsAsked: 0, toolFailureStreak: new Map() },
      recordRun: async () => {}, requestProposal: async () => false,
    };
  };
  const execute = (ctx: AgentToolContext, code: string) => dispatchTool("execute_python", JSON.stringify({ code }), ctx);
  const ctx = startRun();
  const tools = createAgentTools({ ctx, requestProposal: async () => false });
  assert.match(tools.find((t) => t.name === "execute_python")!.description, /load_skill name=semantic-analysis/);
  const loaded = await dispatchTool("load_skill", '{"name":"semantic-analysis"}', ctx);
  assert.equal(loaded.ok, true, loaded.text);
  assert.equal(JSON.parse(loaded.text).source, "system");
  assert.match(loaded.text, /semantic\.classify/);

  const classify = "classified = await semantic.classify(df, columns=['text'], labels={'sports':'sports reporting','business':'business reporting'}, instructions='Classify the subject'); result = classified.summary";
  const first = await execute(ctx, `df = pd.DataFrame({'text':['football match','company earnings'], 'private':['PRIVATE_COLUMN_MUST_NOT_LEAVE']*2}); ${classify}`);
  assert.equal(first.ok, true, first.text);
  assert.equal(approvals, 1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.model, semanticProfile.model, "selected semantic model, not main model");
  assert.match(first.text, /"success":2/);
  assert.ok(progress > 0 && usage > 0, "child usage and progress reach the app callbacks");
  const cached = await execute(startRun(), classify);
  assert.equal(cached.ok, true, cached.text);
  assert.match(cached.text, /"cached":2/);
  assert.equal(requests.length, 1, "cache survives cells and run boundaries within this workspace");
  assert.equal(approvals, 1, "recipient grant is reused");
  await assert.rejects(semanticForPythonJob({ jobId: latestJob, request: "{}" }), /unavailable/);

  approvalMode = "deny";
  const raisedBudget = await execute(startRun({ ...settings,
    semanticBudget: { records: 1000, requests: 200, tokens: 200001 },
  }), classify);
  assert.equal(raisedBudget.ok, false);
  assert.equal(approvals, 2, "raising a budget requires a fresh grant even for cached input");
  assert.equal(requests.length, 1, "denied budget increase sends nothing");
  approvalMode = "allow";
  await resetPythonWorkspace(root, sessionId);
  await workspace.reset!(root, sessionId); // simulated IPC carrier forwards reset explicitly
  const afterReset = await execute(ctx, `df = pd.DataFrame({'text':['football match','company earnings']}); ${classify}`);
  assert.equal(afterReset.ok, true, afterReset.text);
  assert.equal(requests.length, 2, "reset invalidates semantic cache, including the active run's held cache map");
  assert.equal(approvals, 2, "workspace reset preserves recipient authorization");

  const extracted = await execute(ctx, "receipts = pd.DataFrame({'text':['Paid 12 dollars']}); extracted = await semantic.extract(receipts, columns=['text'], schema={'type':'object','properties':{'amount':{'type':'integer'}},'required':['amount'],'additionalProperties':False}, instructions='Extract actual amount paid'); result = extracted.rows.iloc[0]['value']");
  assert.equal(extracted.ok, true, extracted.text);
  assert.match(extracted.text, /"amount":12/);
  const resolved = await execute(ctx, "entities = pd.DataFrame({'name':['A','B','C']}); links = await semantic.resolve(entities, columns=['name'], instructions='Same real entity'); result = int(links.mapping.canonical_id.notna().sum())");
  assert.equal(resolved.ok, true, resolved.text);
  assert.equal(JSON.parse(resolved.text).result.value, 0, "contradictory entity pairs cannot form a merged entity");

  const limited = startRun({ ...settings, semanticBudget: { records: 1, requests: 1, tokens: 20_000 } });
  const beforeLimit = requests.length;
  const beforeLimitRpcs = semanticRpcs;
  const exhausted = await execute(limited, "limited = await semantic.classify(df, columns=['text'], labels={'sports':'sports','business':'business'}, instructions='Budget coverage test'); result = limited.summary");
  assert.equal(exhausted.ok, true, exhausted.text);
  assert.match(exhausted.text, /"unprocessed":2/);
  assert.equal(requests.length, beforeLimit, "impossible full operation sends no model requests");
  assert.equal(semanticRpcs, beforeLimitRpcs + 1, "preflight is one bounded host probe");
  const partial = await execute(limited, "partial = await semantic.classify(df, columns=['text'], labels={'sports':'sports','business':'business'}, instructions='Budget coverage test', allow_partial=True); result = partial.summary");
  assert.equal(partial.ok, true, partial.text);
  assert.match(partial.text, /"unprocessed":1/);
  const exhaustedAgain = await execute(limited, "limited2 = await semantic.classify(df, columns=['text'], labels={'sports':'sports','business':'business'}, instructions='Another instruction must not reset the budget'); result = limited2.summary");
  assert.equal(exhaustedAgain.ok, true, exhaustedAgain.text);
  assert.match(exhaustedAgain.text, /"unprocessed":2/);
  assert.equal(requests.length, beforeLimit + 1);

  const resumed = await execute(startRun(), "completed = await semantic.classify(df, columns=['text'], labels={'sports':'sports','business':'business'}, instructions='Budget coverage test', resume=partial); result = completed.summary");
  assert.equal(resumed.ok, true, resumed.text);
  assert.match(resumed.text, /"reused":1/);
  assert.match(resumed.text, /"complete":true/);
  assert.equal(requests.length, beforeLimit + 2, "resume sends only the missing record across cells and runs");
  const changedResume = await execute(startRun(), "result = await semantic.classify(df.iloc[::-1], columns=['text'], labels={'sports':'sports','business':'business'}, instructions='Budget coverage test', resume=partial)");
  assert.equal(changedResume.ok, false);
  assert.match(changedResume.text, /Resume requires identical/);
  const recordsAccess = await execute(ctx, "result = [r['value'] for r in completed.to_records()]");
  assert.equal(recordsAccess.ok, true, recordsAccess.text);
  const incomplete = await execute(ctx, "result = partial.require_complete()");
  assert.equal(incomplete.ok, false);
  assert.match(incomplete.text, /Incomplete semantic evidence/);
  const missingFieldRpcs = semanticRpcs;
  const missingField = await execute(ctx, "result = await semantic.extract(pd.DataFrame({'text':['paid 12'],'header':['capital']}), columns=['text'], required_fields=['text','header'], schema={'type':'integer'}, instructions='Use header to distinguish expenditure')");
  assert.equal(missingField.ok, false);
  assert.match(missingField.text, /Required fields must be explicitly selected: header/);
  assert.equal(semanticRpcs, missingFieldRpcs, "missing context fails before host/provider transmission");
  const stableIds = await execute(ctx, "keyed = pd.DataFrame({'key':['article-a','article-b'],'text':['football game','company profit']}); keyed_batch = await semantic.classify(keyed, columns=['text'], id_column='key', labels={'sports':'sports','business':'business'}, instructions='Classify keyed articles'); result = keyed_batch.rows.id.tolist()");
  assert.equal(stableIds.ok, true, stableIds.text);
  assert.match(stableIds.text, /article-a/);
  assert.match(stableIds.text, /article-b/);
  const duplicateIds = await execute(ctx, "result = await semantic.classify(pd.DataFrame({'key':['a','a'],'text':['x','y']}), columns=['text'], id_column='key', labels={'sports':'sports'}, instructions='Classify')");
  assert.equal(duplicateIds.ok, false);
  assert.match(duplicateIds.text, /IDs must be unique/);
  const oversized = await execute(ctx, "result = (await semantic.classify(pd.DataFrame({'text':['x'*11000]}),columns=['text'],labels={'sports':'sports'},instructions='Classify')).summary");
  assert.equal(oversized.ok, true, oversized.text);
  assert.match(oversized.text, /"failed":1/);

  const exhaustedRpcStart = semanticRpcs;
  const huge = await execute(limited, "huge = pd.DataFrame({'text':['football '+str(i) for i in range(1000)]}); huge_result = await semantic.classify(huge, columns=['text'], labels={'sports':'sports'}, instructions='Large partial operation', allow_partial=True); result = huge_result.summary");
  assert.equal(huge.ok, true, huge.text);
  assert.match(huge.text, /"unprocessed":1000/);
  assert.ok(semanticRpcs - exhaustedRpcStart <= 5, "stop at the first in-flight group, not every remaining batch");

  const contract = await execute(ctx, "answer_spec = analysis.contract(required=['population','granularity']); answer_spec.claim('population','requested records',source='user request',evidence='requested records'); answer_spec.claim('granularity','subclass',source='user request',evidence='subclass full title'); answer_spec.check_granularity('codes',['C30B11/003'],pattern=r'[A-Z][0-9]{2}[A-Z]',source='query output',evidence='observed full code'); result = answer_spec.report()");
  assert.equal(contract.ok, true, contract.text);
  assert.match(contract.text, /"structurallyReady":false/);
  const persistedContract = await execute(ctx, "result = answer_spec.require_ready()");
  assert.equal(persistedContract.ok, false);
  assert.match(persistedContract.text, /failed checks/);
  const coverage = await execute(ctx, "answer_spec.check_coverage('population',total=10,covered=1,source='complete source snapshot',evidence='one spelling matched only one entity'); result = answer_spec.report()");
  assert.equal(coverage.ok, true, coverage.text);
  assert.match(coverage.text, /"covered":1/);
  const conflict = await execute(ctx, "answer_spec.claim('granularity','subgroup',source='new guess',evidence='no actual definition')");
  assert.equal(conflict.ok, false);
  assert.match(conflict.text, /Conflicting claim/);
  const modelChanged = await execute(startRun({ ...settings, semanticProfileId: profile.id }), "result = await semantic.classify(df, columns=['text'],labels={'sports':'sports','business':'business'},instructions='Budget coverage test',resume=partial)");
  assert.equal(modelChanged.ok, false);
  assert.match(modelChanged.text, /Resume model identity changed/);

  // Revocation prevents even a cached result from bypassing a fresh grant.
  await revokeSemanticGrants(root);
  approvalMode = "deny";
  const beforeDenied = requests.length;
  const denied = await execute(startRun(), classify);
  assert.equal(denied.ok, false);
  assert.match(denied.text, /not authorized/);
  assert.equal(requests.length, beforeDenied);

  approvalMode = "wait";
  const stopApproval = new AbortController();
  const waitingForApproval = new Promise<void>((resolve) => { approvalEntered = resolve; });
  const waiting = execute(startRun(settings, stopApproval), classify);
  await waitingForApproval;
  stopApproval.abort();
  assert.equal((await waiting).ok, false);
  assert.equal(requests.length, beforeDenied, "cancel during authorization sends no data");
  await Promise.all(carriers);
  assert.match(describePythonWorkspace(root, sessionId), /lost/);
  await resetPythonWorkspace(root, sessionId);
  await workspace.reset!(root, sessionId);
  clearSemanticWorkspace(root, sessionId);

  approvalMode = "allow";
  const fallback = await execute(startRun({ ...settings, semanticProfileId: null }), `df = pd.DataFrame({'text':['football match']}); ${classify}`);
  assert.equal(fallback.ok, true, fallback.text);
  assert.equal(requests.at(-1)!.model, profile.model, "unset semantic profile follows the main profile");

  holdProvider = true;
  const stopProvider = new AbortController();
  const providerStarted = new Promise<void>((resolve) => { providerEntered = resolve; });
  const inFlight = execute(startRun(settings, stopProvider), classify);
  await providerStarted;
  stopProvider.abort();
  assert.equal((await inFlight).ok, false);
  await Promise.all(carriers);
  assert.match(describePythonWorkspace(root, sessionId), /lost/);
} finally {
  cancelAllPythonRuntimeJobs();
  for (const job of jobs.values()) job.abort();
  await Promise.all(carriers);
  setPythonRuntimeBroadcaster(null);
  setPythonWorkspaceClearListener(() => {});
  globalThis.fetch = originalFetch;
  clearSemanticWorkspace(root, sessionId);
  await workspace.close();
  await pool.close();
  await fs.rm(root, { recursive: true, force: true });
}
console.log("semantic workflow integration passed: skill, Python, broker, profile, grant, classify/extract/resolve, cache, budgets, cancellation");
