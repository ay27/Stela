import type { PythonExecutionRequest, PythonExecutionResult, PythonExecutionInput } from "@shared/types";

const CHUNK_BYTES = 4 * 1024 * 1024;
const IDLE_MS = 15 * 60_000;
type WorkerMessage =
  | { type: "ready"; jobId: string }
  | { type: "query"; jobId: string; requestId: string; connectionName: string; request: string }
  | { type: "semantic"; jobId: string; requestId: string; request: string }
  | { type: "result"; jobId: string; result: PythonExecutionResult; fatal?: boolean };
interface Workspace {
  id: string;
  worker: Worker;
  active: PythonExecutionRequest | null;
  lastUsed: number;
}
const workspaces = new Map<string, Workspace>();
const queued: PythonExecutionRequest[] = [];
const lostIds = new Set<string>();
let installed = false;

function dispose(workspace: Workspace, lost: boolean): void {
  workspace.worker.terminate();
  workspaces.delete(workspace.id);
  lostIds.add(workspace.id);
  if (lost) void window.stela.pythonRuntime.lost(workspace.id).catch(() => {});
}
async function fail(workspace: Workspace, error: unknown): Promise<void> {
  const job = workspace.active;
  dispose(workspace, true);
  if (job) await window.stela.pythonRuntime.respond(job.jobId, {
    ok: false, stdout: "", value: { kind: "none" }, elapsedMs: 0,
    error: `workspace_lost: ${error instanceof Error ? error.message : String(error)}`,
  });
  drain();
}
async function streamInput(workspace: Workspace, jobId: string, input: PythonExecutionInput): Promise<void> {
  let offset = 0;
  while (workspace.active?.jobId === jobId && workspaces.get(workspace.id) === workspace) {
    const chunk = await window.stela.pythonRuntime.readInput(jobId, input.alias, offset, CHUNK_BYTES);
    if (workspace.active?.jobId !== jobId || workspaces.get(workspace.id) !== workspace) return;
    offset += chunk.data.byteLength;
    workspace.worker.postMessage({ type: "chunk", jobId, alias: input.alias, data: chunk.data, eof: chunk.eof }, [chunk.data.buffer]);
    if (chunk.eof) return;
  }
}
async function message(workspace: Workspace, event: WorkerMessage): Promise<void> {
  const request = workspace.active;
  if (!request || request.jobId !== event.jobId || workspaces.get(workspace.id) !== workspace) return;
  const reply = (payload: object): void => {
    if (workspace.active?.jobId === event.jobId && workspaces.get(workspace.id) === workspace) workspace.worker.postMessage({ jobId: event.jobId, ...payload });
  };
  if (event.type === "ready") {
    for (const input of request.inputs) await streamInput(workspace, event.jobId, input);
    return;
  }
  if (event.type === "semantic") {
    try {
      const result = await window.stela.pythonRuntime.semantic(event.jobId, event.request);
      reply({ type: "semantic-result", requestId: event.requestId, result: JSON.stringify(result) });
    } catch (error) {
      reply({ type: "semantic-result", requestId: event.requestId, error: String(error) });
    }
    return;
  }
  if (event.type === "query") {
    try {
      const input = await window.stela.pythonRuntime.query(event.jobId, event.connectionName, event.request);
      reply({ type: "query-input", requestId: event.requestId, input });
      await streamInput(workspace, event.jobId, input);
    } catch (error) {
      reply({ type: "query-error", requestId: event.requestId, error: String(error) });
    }
    return;
  }
  workspace.active = null;
  workspace.lastUsed = Date.now();
  if (event.fatal) {
    dispose(workspace, true);
    event.result.error = `workspace_lost: ${event.result.error ?? "Worker failed"}`;
  }
  await window.stela.pythonRuntime.respond(event.jobId, event.result);
  drain();
}
function drain(): void {
  for (let i = 0; i < queued.length;) {
    const request = queued[i]!;
    const id = request.workspaceId ?? request.jobId;
    let workspace = workspaces.get(id);
    if (!workspace && lostIds.has(id)) {
      queued.splice(i, 1);
      void window.stela.pythonRuntime.respond(request.jobId, { ok: false, stdout: "", value: { kind: "none" }, elapsedMs: 0,
        error: "workspace_lost: this workspace was disposed; rebuild explicitly" });
      continue;
    }
    if (workspace?.active) { i++; continue; }
    if (!workspace && workspaces.size >= 2) {
      const idle = [...workspaces.values()].filter((w) => !w.active).sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (!idle) { i++; continue; }
      dispose(idle, true);
    }
    if (!workspace) {
      const worker = new Worker(new URL("./python-runtime.worker.ts", import.meta.url), { type: "module", name: "stela-python-workspace" });
      workspace = { id, worker, active: null, lastUsed: Date.now() };
      const owner = workspace;
      worker.addEventListener("message", (e: MessageEvent<WorkerMessage>) => { void message(owner, e.data).catch((error) => fail(owner, error)); });
      worker.addEventListener("error", (e) => { void fail(owner, e.message); });
      workspaces.set(id, workspace);
    }
    queued.splice(i, 1);
    workspace.active = request;
    workspace.worker.postMessage({ type: "start", request, assetBaseUrl: new URL("pyodide/", window.location.href).href });
  }
}
export function installPythonRuntime(): () => void {
  if (installed) return () => {};
  installed = true;
  const offRequest = window.stela.pythonRuntime.onRequest((request) => { queued.push(request); drain(); });
  const offCancel = window.stela.pythonRuntime.onCancel((jobId) => {
    const index = queued.findIndex((r) => r.jobId === jobId);
    if (index >= 0) queued.splice(index, 1);
    for (const w of workspaces.values()) if (w.active?.jobId === jobId) dispose(w, true);
    drain();
  });
  const offReset = window.stela.pythonRuntime.onReset((id) => {
    const workspace = workspaces.get(id);
    if (workspace) dispose(workspace, false);
    drain();
  });
  const timer = setInterval(() => {
    for (const w of workspaces.values()) if (!w.active && Date.now() - w.lastUsed >= IDLE_MS) dispose(w, true);
  }, 60_000);
  return () => {
    installed = false;
    offRequest(); offCancel(); offReset(); clearInterval(timer);
    queued.splice(0);
    for (const w of workspaces.values()) dispose(w, true);
  };
}
