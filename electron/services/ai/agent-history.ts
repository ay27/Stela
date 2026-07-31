import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  JsonlSessionStorage,
  loadJsonlSessionMetadata,
  type SessionTreeEntry,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";

import { AppError } from "@shared/errors";
import type {
  AgentEvent,
  AgentHistoryRef,
  AgentHistoryRun,
  AgentHistorySession,
  AgentHistorySummary,
  AgentProposalResponse,
  AgentRunRequest,
} from "@shared/types";

import { ensureWithinVault } from "../vault-fs";
import { vaultConfigDir } from "../vault-paths";

const HISTORY_DIR = "agent-history";
const STELA_RUN_STARTED = "stela_agent_run_started";
const STELA_RUN_EVENT = "stela_agent_run_event";
const STELA_PROPOSAL_RESPONSE = "stela_agent_proposal_response";
const STELA_RUN_FINISHED = "stela_agent_run_finished";
const SAFE_SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;
export const MAX_AGENT_HISTORY_SESSIONS = 20;
const pruneQueues = new Map<string, Promise<AgentHistoryRef[]>>();

function assertSafeSegment(value: string, label: string): void {
  if (!SAFE_SEGMENT.test(value)) {
    throw new AppError("agent_history_invalid_id", `Invalid agent history ${label}.`);
  }
}

function rootPath(vaultPath: string): string {
  return path.join(vaultConfigDir(vaultPath), HISTORY_DIR);
}

async function sessionPath(vaultPath: string, ref: AgentHistoryRef): Promise<string> {
  assertSafeSegment(ref.deviceSlug, "device");
  assertSafeSegment(ref.sessionId, "session");
  return ensureWithinVault(vaultPath, path.join(rootPath(vaultPath), ref.deviceSlug, `${ref.sessionId}.jsonl`));
}

function envFor(vaultPath: string): NodeExecutionEnv {
  return new NodeExecutionEnv({ cwd: vaultPath });
}

function toMillis(value: string): number {
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? millis : 0;
}

function historyTitle(prompt: string): string {
  return prompt.trim().replace(/\s+/g, " ").slice(0, 28) || "New";
}

async function appendCustom(
  storage: JsonlSessionStorage,
  customType: string,
  data: unknown,
): Promise<void> {
  const entry: Extract<SessionTreeEntry, { type: "custom" }> = {
    type: "custom",
    id: await storage.createEntryId(),
    parentId: await storage.getLeafId(),
    timestamp: new Date().toISOString(),
    customType,
    data,
  };
  await storage.appendEntry(entry);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isPlanStep(value: unknown): boolean {
  const step = asRecord(value);
  return !!step &&
    typeof step.id === "string" &&
    typeof step.title === "string" &&
    typeof step.intent === "string" &&
    typeof step.acceptance === "string" &&
    ["pending", "running", "completed", "blocked", "skipped"].includes(String(step.status)) &&
    (step.evidence === undefined || typeof step.evidence === "string") &&
    (step.runId === undefined || typeof step.runId === "string");
}

function isProposalPayload(value: unknown): boolean {
  const payload = asRecord(value);
  return !!payload &&
    typeof payload.description === "string" &&
    ["notePath", "sql", "oldContent", "newContent", "question"].every(
      (key) => payload[key] === undefined || typeof payload[key] === "string",
    ) &&
    (payload.options === undefined ||
      (Array.isArray(payload.options) && payload.options.every((option) => typeof option === "string")));
}

function isSkillMaintenanceAction(value: unknown): boolean {
  const action = asRecord(value);
  return !!action &&
    (action.action === "saved" || action.action === "archived") &&
    typeof action.name === "string" &&
    typeof action.path === "string" &&
    typeof action.reason === "string";
}

function asAgentEvent(value: unknown): AgentEvent | null {
  const event = asRecord(value);
  if (!event || typeof event.runId !== "string") return null;
  switch (event.type) {
    case "started":
    case "skill_maintenance_started":
    case "history_updated":
    case "cancelled":
      return event as AgentEvent;
    case "plan_updated": {
      const plan = asRecord(event.plan);
      return plan &&
        typeof plan.runId === "string" &&
        typeof plan.version === "number" &&
        Array.isArray(plan.steps) &&
        plan.steps.every(isPlanStep)
        ? event as AgentEvent
        : null;
    }
    case "tool_call": {
      const call = asRecord(event.call);
      return call &&
        typeof call.callId === "string" &&
        typeof call.name === "string" &&
        "arguments" in call
        ? event as AgentEvent
        : null;
    }
    case "tool_result":
      return typeof event.callId === "string" &&
        typeof event.ok === "boolean" &&
        typeof event.summary === "string"
        ? event as AgentEvent
        : null;
    case "proposal": {
      const payload = asRecord(event.payload);
      return typeof event.callId === "string" &&
        (event.kind === "edit_note" || event.kind === "mutation_sql" || event.kind === "question") &&
        isProposalPayload(payload)
        ? event as AgentEvent
        : null;
    }
    case "context_usage":
      return typeof event.usedTokens === "number" &&
        typeof event.contextWindow === "number" &&
        typeof event.estimated === "boolean"
        ? event as AgentEvent
        : null;
    case "compaction":
      return event.phase === "started" || event.phase === "completed" ? event as AgentEvent : null;
    case "skill_maintenance":
      return Array.isArray(event.actions) &&
        event.actions.every(isSkillMaintenanceAction) &&
        typeof event.summary === "string"
        ? event as AgentEvent
        : null;
    case "final":
      return typeof event.content === "string" ? event as AgentEvent : null;
    case "error":
      return typeof event.message === "string" ? event as AgentEvent : null;
    default:
      return null;
  }
}

function asProposalResponse(value: unknown): AgentProposalResponse | null {
  const response = asRecord(value);
  return response &&
    typeof response.runId === "string" &&
    typeof response.callId === "string" &&
    typeof response.approve === "boolean"
    ? response as AgentProposalResponse
    : null;
}

function asRunRequest(value: unknown): AgentRunRequest | null {
  const request = asRecord(value);
  if (!request || typeof request.runId !== "string" || typeof request.prompt !== "string") return null;
  const strings = (input: unknown): string[] | undefined =>
    Array.isArray(input) && input.every((item) => typeof item === "string")
      ? input
      : undefined;
  return {
    runId: request.runId,
    prompt: request.prompt,
    ...(typeof request.sessionId === "string" ? { sessionId: request.sessionId } : {}),
    ...(strings(request.mentionedTables) ? { mentionedTables: strings(request.mentionedTables) } : {}),
    ...(strings(request.referencedNotes) ? { referencedNotes: strings(request.referencedNotes) } : {}),
  };
}

function historyFromEntries(
  entries: SessionTreeEntry[],
  summary: AgentHistorySummary,
): AgentHistorySession {
  const runs = new Map<string, AgentHistoryRun>();
  for (const entry of entries) {
    if (entry.type !== "custom") continue;
    const data = asRecord(entry.data);
    if (!data) continue;
    if (entry.customType === STELA_RUN_STARTED) {
      const request = asRunRequest(data.request);
      const startedAt = typeof data.startedAt === "number" ? data.startedAt : toMillis(entry.timestamp);
      if (request) {
        runs.set(request.runId, {
          request,
          startedAt,
          finishedAt: null,
          events: [],
          proposalResponses: [],
        });
      }
      continue;
    }
    const runId = typeof data.runId === "string" ? data.runId : null;
    if (!runId) continue;
    const run = runs.get(runId);
    if (!run) continue;
    if (entry.customType === STELA_RUN_EVENT) {
      const event = asAgentEvent(data.event);
      if (event) run.events.push(event);
    } else if (entry.customType === STELA_PROPOSAL_RESPONSE) {
      const response = asProposalResponse(data.response);
      if (response) run.proposalResponses.push(response);
    } else if (entry.customType === STELA_RUN_FINISHED) {
      run.finishedAt = typeof data.finishedAt === "number" ? data.finishedAt : toMillis(entry.timestamp);
    }
  }
  return { summary, runs: [...runs.values()].sort((left, right) => left.startedAt - right.startedAt) };
}

async function loadFromRef(
  vaultPath: string,
  ref: AgentHistoryRef,
  isLocal: boolean,
): Promise<AgentHistorySession> {
  const filePath = await sessionPath(vaultPath, ref);
  const env = envFor(vaultPath);
  const metadata = await loadJsonlSessionMetadata(env, filePath);
  const storage = await JsonlSessionStorage.open(env, filePath);
  const entries = await storage.getEntries();
  const createdAt = toMillis(metadata.createdAt);
  const updatedAt = entries.reduce((latest, entry) => Math.max(latest, toMillis(entry.timestamp)), createdAt);
  const firstRun = entries.find(
    (entry) =>
      entry.type === "custom" &&
      entry.customType === STELA_RUN_STARTED &&
      asRunRequest(asRecord(entry.data)?.request),
  );
  const firstRequest = firstRun?.type === "custom"
    ? asRunRequest(asRecord(firstRun.data)?.request)
    : null;
  const summary: AgentHistorySummary = {
    ...ref,
    title: firstRequest ? historyTitle(firstRequest.prompt) : "New",
    createdAt,
    updatedAt,
    isLocal,
  };
  return historyFromEntries(entries, summary);
}

export async function openLocalAgentSessionStorage(
  vaultPath: string,
  deviceSlug: string,
  sessionId: string,
): Promise<JsonlSessionStorage> {
  const ref = { deviceSlug, sessionId };
  const filePath = await sessionPath(vaultPath, ref);
  const env = envFor(vaultPath);
  try {
    await fs.access(filePath);
    return JsonlSessionStorage.open(env, filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  return JsonlSessionStorage.create(env, filePath, {
    cwd: vaultPath,
    sessionId,
    metadata: { stela: { deviceSlug } },
  });
}

export async function appendAgentHistoryStarted(
  storage: JsonlSessionStorage,
  request: AgentRunRequest,
): Promise<void> {
  await appendCustom(storage, STELA_RUN_STARTED, { request, startedAt: Date.now() });
}

export async function appendAgentHistoryEvent(
  storage: JsonlSessionStorage,
  event: AgentEvent,
): Promise<void> {
  await appendCustom(storage, STELA_RUN_EVENT, { runId: event.runId, event });
}

export async function appendAgentHistoryProposalResponse(
  storage: JsonlSessionStorage,
  response: AgentProposalResponse,
): Promise<void> {
  await appendCustom(storage, STELA_PROPOSAL_RESPONSE, { runId: response.runId, response });
}

export async function appendAgentHistoryFinished(
  storage: JsonlSessionStorage,
  runId: string,
): Promise<void> {
  await appendCustom(storage, STELA_RUN_FINISHED, { runId, finishedAt: Date.now() });
}

export async function loadAgentHistory(
  vaultPath: string,
  ref: AgentHistoryRef,
  localDeviceSlug: string = ref.deviceSlug,
): Promise<AgentHistorySession> {
  return loadFromRef(vaultPath, ref, ref.deviceSlug === localDeviceSlug);
}

export async function listAgentHistory(
  vaultPath: string,
  localDeviceSlug: string,
): Promise<AgentHistorySummary[]> {
  const root = await ensureWithinVault(vaultPath, rootPath(vaultPath));
  let deviceDirectories: import("node:fs").Dirent[];
  try {
    deviceDirectories = await fs.readdir(root, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const summaries: AgentHistorySummary[] = [];
  for (const directory of deviceDirectories) {
    if (!directory.isDirectory() || !SAFE_SEGMENT.test(directory.name)) continue;
    const deviceSlug = directory.name;
    const devicePath = path.join(root, deviceSlug);
    const files = await fs.readdir(devicePath, { withFileTypes: true }).catch(() => []);
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
      const sessionId = file.name.slice(0, -".jsonl".length);
      if (!SAFE_SEGMENT.test(sessionId)) continue;
      try {
        const history = await loadFromRef(vaultPath, { sessionId, deviceSlug }, deviceSlug === localDeviceSlug);
        summaries.push(history.summary);
      } catch {
        // 损坏或半同步的 JSONL 不能阻塞其它会话恢复。
      }
    }
  }
  return summaries.sort((left, right) => right.updatedAt - left.updatedAt || right.sessionId.localeCompare(left.sessionId));
}

export async function forkAgentHistorySession(
  vaultPath: string,
  localDeviceSlug: string,
  source: AgentHistoryRef,
): Promise<AgentHistoryRef> {
  const sourcePath = await sessionPath(vaultPath, source);
  const env = envFor(vaultPath);
  const sourceStorage = await JsonlSessionStorage.open(env, sourcePath);
  const sessionId = `sess_${randomUUID()}`;
  const target = await openLocalAgentSessionStorage(vaultPath, localDeviceSlug, sessionId);
  for (const entry of await sourceStorage.getEntries()) {
    await target.appendEntry(entry);
  }
  return { sessionId, deviceSlug: localDeviceSlug };
}

export async function prepareLocalAgentHistorySession(
  vaultPath: string,
  localDeviceSlug: string,
  requestedSessionId?: string,
): Promise<AgentHistoryRef> {
  if (!requestedSessionId) {
    return { sessionId: `sess_${randomUUID()}`, deviceSlug: localDeviceSlug };
  }
  assertSafeSegment(requestedSessionId, "session");
  const localRef = { sessionId: requestedSessionId, deviceSlug: localDeviceSlug };
  try {
    await fs.access(await sessionPath(vaultPath, localRef));
    return localRef;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const remote = (await listAgentHistory(vaultPath, localDeviceSlug)).find(
    (summary) => summary.sessionId === requestedSessionId && !summary.isLocal,
  );
  return remote
    ? forkAgentHistorySession(vaultPath, localDeviceSlug, remote)
    : localRef;
}

async function pruneLocalAgentHistoryOnce(
  vaultPath: string,
  deviceSlug: string,
  getProtectedSessionIds: () => ReadonlySet<string>,
): Promise<AgentHistoryRef[]> {
  const candidates = (await listAgentHistory(vaultPath, deviceSlug))
    .filter((summary) => summary.deviceSlug === deviceSlug)
    .slice(MAX_AGENT_HISTORY_SESSIONS)
    .map(({ sessionId }) => ({ sessionId, deviceSlug }));
  const resolvedCandidates = await Promise.all(
    candidates.map(async (ref) => ({ ref, filePath: await sessionPath(vaultPath, ref) })),
  );
  const stale: AgentHistoryRef[] = [];
  for (const { ref, filePath } of resolvedCandidates) {
    if (getProtectedSessionIds().has(ref.sessionId)) continue;
    await fs.rm(filePath, { force: true });
    stale.push(ref);
  }
  return stale;
}

export function pruneLocalAgentHistory(
  vaultPath: string,
  deviceSlug: string,
  getProtectedSessionIds: () => ReadonlySet<string> = () => new Set(),
): Promise<AgentHistoryRef[]> {
  assertSafeSegment(deviceSlug, "device");
  const key = `${vaultPath}\0${deviceSlug}`;
  const previous = pruneQueues.get(key) ?? Promise.resolve([]);
  const next = previous
    .catch(() => [])
    .then(() => pruneLocalAgentHistoryOnce(vaultPath, deviceSlug, getProtectedSessionIds));
  pruneQueues.set(key, next);
  return next.finally(() => {
    if (pruneQueues.get(key) === next) pruneQueues.delete(key);
  });
}
