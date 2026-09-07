import assert from "node:assert/strict";
import type { PythonExecutionRequest, PythonExecutionResult } from "@shared/types";

let onRequest: (request: PythonExecutionRequest) => void = () => {};
let onCancel: (jobId: string) => void = () => {};
let onReset: (workspaceId: string) => void = () => {};
const results: Array<{ jobId: string; result: PythonExecutionResult }> = [];
const lost: string[] = [];
class FakeWorker {
  static instances: FakeWorker[] = [];
  readonly sent: Array<{ type: string; request?: PythonExecutionRequest }> = [];
  terminated = false;
  private listeners = new Map<string, (event: { data: unknown; message?: string }) => void>();
  constructor() { FakeWorker.instances.push(this); }
  addEventListener(name: string, callback: (event: { data: unknown; message?: string }) => void): void { this.listeners.set(name, callback); }
  postMessage(message: { type: string; request?: PythonExecutionRequest }): void { this.sent.push(message); }
  terminate(): void { this.terminated = true; }
  crash(): void { this.listeners.get("error")?.({ data: undefined, message: "fixture Worker crash" }); }
  result(jobId: string): void {
    this.listeners.get("message")?.({ data: { type: "result", jobId,
      result: { ok: true, stdout: "", value: { kind: "none" }, elapsedMs: 1 } } });
  }
}
const originalWorker = globalThis.Worker;
const originalWindow = globalThis.window;
Object.defineProperty(globalThis, "Worker", { value: FakeWorker, configurable: true });
Object.defineProperty(globalThis, "window", { configurable: true, value: {
  location: { href: "file:///test/index.html" },
  stela: { pythonRuntime: {
    onRequest: (fn: typeof onRequest) => { onRequest = fn; return () => {}; },
    onCancel: (fn: typeof onCancel) => { onCancel = fn; return () => {}; },
    onReset: (fn: typeof onReset) => { onReset = fn; return () => {}; },
    respond: async (jobId: string, result: PythonExecutionResult) => { results.push({ jobId, result }); return { accepted: true }; },
    lost: async (workspaceId: string) => { lost.push(workspaceId); return { accepted: true }; },
  } },
} });
const { installPythonRuntime } = await import("./python-runtime");
const dispose = installPythonRuntime();
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const request = (workspaceId: string, jobId: string): PythonExecutionRequest => ({ workspaceId, jobId, inputs: [], code: "result = 1", timeoutMs: 1000 });
try {
  onRequest(request("a", "a1"));
  onRequest(request("b", "b1"));
  onRequest(request("c", "c1"));
  assert.equal(FakeWorker.instances.length, 2, "active workers are bounded and not evicted");
  FakeWorker.instances[0]!.result("a1");
  await tick();
  assert.equal(FakeWorker.instances.length, 3);
  assert.equal(FakeWorker.instances[0]!.terminated, true);
  assert.deepEqual(lost, ["a"]);
  onRequest(request("a", "a2"));
  await tick();
  assert.match(results.find((r) => r.jobId === "a2")?.result.error ?? "", /workspace_lost/);
  onCancel("c1");
  assert.equal(FakeWorker.instances[2]!.terminated, true);
  FakeWorker.instances[2]!.result("c1");
  await tick();
  assert.equal(results.some((r) => r.jobId === "c1"), false, "late result cannot resurrect a cancelled job");
  FakeWorker.instances[1]!.result("b1");
  await tick();
  onRequest(request("b", "b2"));
  assert.equal(FakeWorker.instances.length, 3, "same workspace reuses its Worker");
  FakeWorker.instances[1]!.result("b2");
  await tick();
  onReset("b");
  assert.equal(FakeWorker.instances[1]!.terminated, true);
  onRequest(request("crash", "crash1"));
  const crashed = FakeWorker.instances.at(-1)!;
  crashed.crash();
  await tick();
  assert.equal(crashed.terminated, true);
  assert.ok(lost.includes("crash"));
  assert.match(results.find((r) => r.jobId === "crash1")?.result.error ?? "", /workspace_lost.*fixture Worker crash/);
  onRequest(request("crash", "crash2"));
  await tick();
  assert.match(results.find((r) => r.jobId === "crash2")?.result.error ?? "", /workspace_lost/);
  const countBeforeRebuild = FakeWorker.instances.length;
  onRequest(request("rebuilt", "rebuilt1"));
  assert.equal(FakeWorker.instances.length, countBeforeRebuild + 1);
  const rebuilt = FakeWorker.instances.at(-1)!;
  assert.equal(rebuilt.sent.length, 1, "new Worker receives only the explicit rebuild cell");
  rebuilt.result("rebuilt1");
  await tick();
  assert.equal(results.find((r) => r.jobId === "rebuilt1")?.result.ok, true);
} finally {
  dispose();
  Object.defineProperty(globalThis, "Worker", { value: originalWorker, configurable: true });
  Object.defineProperty(globalThis, "window", { value: originalWindow, configurable: true });
}
console.log("desktop Python workspace lifecycle tests passed");
