import type {
  PythonExecutionRequest,
  PythonExecutionResult,
} from "@shared/types";

const CHUNK_BYTES = 4 * 1024 * 1024;

type WorkerMessage =
  | { type: "ready"; jobId: string }
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

async function streamInputs(request: PythonExecutionRequest): Promise<void> {
  const target = worker;
  if (!target || activeRequest?.jobId !== request.jobId) return;
  for (const input of request.inputs) {
    let offset = 0;
    while (true) {
      if (!worker || activeRequest?.jobId !== request.jobId) return;
      const chunk = await window.stela.pythonRuntime.readInput(
        request.jobId,
        input.alias,
        offset,
        CHUNK_BYTES,
      );
      const data = chunk.data;
      const bytesRead = data.byteLength;
      target.postMessage(
        { type: "chunk", jobId: request.jobId, alias: input.alias, data, eof: chunk.eof },
        [data.buffer],
      );
      offset += bytesRead;
      if (chunk.eof) break;
    }
  }
}

async function handleWorkerMessage(message: WorkerMessage): Promise<void> {
  const request = activeRequest;
  if (!request || request.jobId !== message.jobId) return;
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
