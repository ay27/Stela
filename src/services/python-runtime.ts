import type {
  PythonExecutionInput,
  PythonExecutionRequest,
  PythonExecutionResult,
} from "@shared/types";

const CHUNK_BYTES = 4 * 1024 * 1024;

type WorkerMessage =
  | { type: "ready"; jobId: string }
  | { type: "query"; jobId: string; requestId: string; connectionName: string; request: string }
  | { type: "result"; jobId: string; result: PythonExecutionResult; fatal?: boolean };

let worker: Worker | null = null;
let activeRequest: PythonExecutionRequest | null = null;
let installed = false;

function assetBaseUrl(): string {
  return new URL("pyodide/", window.location.href).href;
}

function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./python-runtime.worker.ts", import.meta.url), {
    type: "module",
    name: "stela-python-runtime",
  });
  worker.addEventListener("message", (event: MessageEvent<WorkerMessage>) => {
    void handleWorkerMessage(event.data);
  });
  worker.addEventListener("error", (event) => {
    const request = activeRequest;
    resetWorker();
    if (!request) return;
    void window.stela.pythonRuntime.respond(request.jobId, {
      ok: false,
      stdout: "",
      value: { kind: "none" },
      elapsedMs: 0,
      error: event.message || "Python Worker crashed",
    });
  });
  return worker;
}

function resetWorker(): void {
  worker?.terminate();
  worker = null;
  activeRequest = null;
}

/** Pull one artifact into the worker's virtual filesystem, 4MB at a time. */
async function streamInput(jobId: string, alias: string): Promise<void> {
  let offset = 0;
  while (true) {
    const target = worker;
    if (!target || activeRequest?.jobId !== jobId) return;
    const chunk = await window.stela.pythonRuntime.readInput(jobId, alias, offset, CHUNK_BYTES);
    const data = chunk.data;
    offset += data.byteLength;
    target.postMessage({ type: "chunk", jobId, alias, data, eof: chunk.eof }, [data.buffer]);
    if (chunk.eof) return;
  }
}

async function streamInputs(request: PythonExecutionRequest): Promise<void> {
  for (const input of request.inputs) {
    await streamInput(request.jobId, input.alias);
  }
}

/**
 * Serve one sandbox `await query(...)`: main runs it read-only and hands back a
 * descriptor, then the bytes travel over the same chunk path as staged inputs.
 * The descriptor goes first so the worker can open its stream before any chunk
 * lands; the sandbox promise resolves on eof.
 */
async function handleQuery(message: Extract<WorkerMessage, { type: "query" }>): Promise<void> {
  let descriptor: PythonExecutionInput;
  try {
    descriptor = await window.stela.pythonRuntime.query(
      message.jobId,
      message.connectionName,
      message.request,
    );
  } catch (error) {
    worker?.postMessage({
      type: "query-error",
      jobId: message.jobId,
      requestId: message.requestId,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  worker?.postMessage({
    type: "query-input",
    jobId: message.jobId,
    requestId: message.requestId,
    input: descriptor,
  });
  try {
    await streamInput(message.jobId, descriptor.alias);
  } catch (error) {
    worker?.postMessage({
      type: "query-error",
      jobId: message.jobId,
      requestId: message.requestId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleWorkerMessage(message: WorkerMessage): Promise<void> {
  const request = activeRequest;
  if (!request || request.jobId !== message.jobId) return;
  if (message.type === "query") {
    await handleQuery(message);
    return;
  }
  if (message.type === "ready") {
    try {
      await streamInputs(request);
    } catch (error) {
      resetWorker();
      await window.stela.pythonRuntime.respond(request.jobId, {
        ok: false,
        stdout: "",
        value: { kind: "none" },
        elapsedMs: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }
  activeRequest = null;
  if (message.fatal) {
    worker?.terminate();
    worker = null;
  }
  await window.stela.pythonRuntime.respond(message.jobId, message.result);
}

async function start(request: PythonExecutionRequest): Promise<void> {
  if (activeRequest) {
    await window.stela.pythonRuntime.respond(request.jobId, {
      ok: false,
      stdout: "",
      value: { kind: "none" },
      elapsedMs: 0,
      error: "Python runtime is busy",
    });
    return;
  }
  activeRequest = request;
  ensureWorker().postMessage({
    type: "start",
    request,
    assetBaseUrl: assetBaseUrl(),
  });
}

export function installPythonRuntime(): () => void {
  if (installed) return () => {};
  installed = true;
  const offRequest = window.stela.pythonRuntime.onRequest((request) => {
    void start(request);
  });
  const offCancel = window.stela.pythonRuntime.onCancel((jobId) => {
    if (activeRequest?.jobId === jobId) resetWorker();
  });
  return () => {
    installed = false;
    offRequest();
    offCancel();
    resetWorker();
  };
}
