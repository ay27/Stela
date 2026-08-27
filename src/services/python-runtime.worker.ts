/// <reference lib="webworker" />

import { loadPyodide, type PyodideInterface } from "pyodide";

import {
  PYTHON_EXECUTE_SCRIPT,
  STELA_PYODIDE_PACKAGES,
} from "./python-runtime-core";

import type {
  PythonExecutionInput,
  PythonExecutionRequest,
  PythonExecutionResult,
} from "@shared/types";

type StartMessage = {
  type: "start";
  request: PythonExecutionRequest;
  assetBaseUrl: string;
};
type ChunkMessage = {
  type: "chunk";
  jobId: string;
  alias: string;
  data: Uint8Array;
  eof: boolean;
};
type QueryInputMessage = {
  type: "query-input";
  jobId: string;
  requestId: string;
  input: PythonExecutionInput;
};
type QueryErrorMessage = {
  type: "query-error";
  jobId: string;
  requestId: string;
  error: string;
};
type InboundMessage = StartMessage | ChunkMessage | QueryInputMessage | QueryErrorMessage;

interface ActiveInput {
  path: string;
  stream: ReturnType<PyodideInterface["FS"]["open"]>;
  complete: boolean;
}

interface PendingQuery {
  resolve: (descriptorJson: string) => void;
  reject: (error: Error) => void;
  alias: string;
}

interface ActiveJob {
  request: PythonExecutionRequest;
  /** Artifacts staged before execution; completing all of them starts the run. */
  inputs: Map<string, ActiveInput>;
  /** Artifacts pulled mid-execution by `query()`, keyed by generated alias. */
  fetched: Map<string, ActiveInput>;
  pendingQueries: Map<string, PendingQuery>;
  queriesByAlias: Map<string, string>;
  descriptors: Map<string, PythonExecutionInput>;
  queryCounter: number;
}

const runtimeGlobals = Object.freeze({});
let pyodidePromise: Promise<PyodideInterface> | null = null;
let active: ActiveJob | null = null;

function post(message: unknown): void {
  self.postMessage(message);
}

async function runtime(assetBaseUrl: string): Promise<PyodideInterface> {
  pyodidePromise ??= loadPyodide({
    indexURL: assetBaseUrl,
    packageBaseUrl: assetBaseUrl,
    lockFileURL: new URL("pyodide-lock.json", assetBaseUrl).href,
    packages: [...STELA_PYODIDE_PACKAGES],
    jsglobals: runtimeGlobals,
    stdout: () => {},
    stderr: () => {},
  });
  return pyodidePromise;
}

function safeInputPath(jobId: string, alias: string, format: "parquet" | "jsonl"): string {
  const extension = format === "parquet" ? "parquet" : "jsonl";
  return `/stela-inputs/${jobId}/${alias}.${extension}`;
}

/**
 * The one JS callable handed to Python. Sends a connection name plus a
 * JSON-encoded query request to the host and resolves once the resulting
 * artifact has fully landed in the virtual filesystem.
 */
function requestQuery(connectionName: unknown, request: unknown): Promise<string> {
  const job = active;
  if (!job) return Promise.reject(new Error("Python runtime has no active job"));
  job.queryCounter += 1;
  const requestId = `r${job.queryCounter}`;
  return new Promise<string>((resolve, reject) => {
    job.pendingQueries.set(requestId, { resolve, reject, alias: "" });
    post({
      type: "query",
      jobId: job.request.jobId,
      requestId,
      connectionName: String(connectionName),
      request: String(request),
    });
  });
}

async function start(message: StartMessage): Promise<void> {
  if (active) throw new Error("Python runtime already has an active job");
  const py = await runtime(message.assetBaseUrl);
  const dir = `/stela-inputs/${message.request.jobId}`;
  try {
    py.FS.mkdirTree(dir);
  } catch {
    // A cancelled worker is terminated; this only covers a stale empty directory.
  }
  const inputs = new Map<string, ActiveInput>();
  for (const input of message.request.inputs) {
    const inputPath = safeInputPath(message.request.jobId, input.alias, input.format);
    inputs.set(input.alias, {
      path: inputPath,
      stream: py.FS.open(inputPath, "w"),
      complete: false,
    });
  }
  active = {
    request: message.request,
    inputs,
    fetched: new Map(),
    pendingQueries: new Map(),
    queriesByAlias: new Map(),
    descriptors: new Map(),
    queryCounter: 0,
  };
  post({ type: "ready", jobId: message.request.jobId });
  if (inputs.size === 0) await executeActive(py);
}

function queryInput(message: QueryInputMessage): void {
  const job = active;
  if (!job || job.request.jobId !== message.jobId) return;
  const pendingQuery = job.pendingQueries.get(message.requestId);
  if (!pendingQuery) return;
  const alias = message.input.alias;
  pendingQuery.alias = alias;
  job.queriesByAlias.set(alias, message.requestId);
  job.descriptors.set(alias, message.input);
}

function queryError(message: QueryErrorMessage): void {
  const job = active;
  if (!job || job.request.jobId !== message.jobId) return;
  const pendingQuery = job.pendingQueries.get(message.requestId);
  if (!pendingQuery) return;
  job.pendingQueries.delete(message.requestId);
  if (pendingQuery.alias) job.queriesByAlias.delete(pendingQuery.alias);
  pendingQuery.reject(new Error(message.error));
}

async function chunk(message: ChunkMessage): Promise<void> {
  const job = active;
  if (!job || job.request.jobId !== message.jobId) return;
  const py = await pyodidePromise!;
  const requestId = job.queriesByAlias.get(message.alias);
  if (requestId) {
    let target = job.fetched.get(message.alias);
    if (!target) {
      const descriptor = job.descriptors.get(message.alias)!;
      const filePath = safeInputPath(message.jobId, message.alias, descriptor.format);
      target = { path: filePath, stream: py.FS.open(filePath, "w"), complete: false };
      job.fetched.set(message.alias, target);
    }
    if (target.complete) return;
    if (message.data.byteLength > 0) {
      py.FS.write(target.stream, message.data, 0, message.data.byteLength);
    }
    if (!message.eof) return;
    py.FS.close(target.stream);
    target.complete = true;
    const pendingQuery = job.pendingQueries.get(requestId);
    job.pendingQueries.delete(requestId);
    job.queriesByAlias.delete(message.alias);
    pendingQuery?.resolve(
      JSON.stringify({ ...job.descriptors.get(message.alias)!, path: target.path }),
    );
    return;
  }
  const input = job.inputs.get(message.alias);
  if (!input || input.complete) return;
  if (message.data.byteLength > 0) {
    py.FS.write(input.stream, message.data, 0, message.data.byteLength);
  }
  if (message.eof) {
    py.FS.close(input.stream);
    input.complete = true;
  }
  if ([...job.inputs.values()].every((item) => item.complete)) {
    await executeActive(py);
  }
}

async function executeActive(py: PyodideInterface): Promise<void> {
  const job = active;
  if (!job) return;
  const startedAt = Date.now();
  try {
    const config = job.request.inputs.map((input) => ({
      ...input,
      path: job.inputs.get(input.alias)?.path,
    }));
    py.globals.set("__stela_code", job.request.code);
    py.globals.set("__stela_inputs_json", JSON.stringify(config));
    py.globals.set("__stela_query", job.request.canQuery ? requestQuery : null);
    const raw = await py.runPythonAsync(PYTHON_EXECUTE_SCRIPT);
    const parsed = JSON.parse(String(raw)) as Omit<PythonExecutionResult, "elapsedMs">;
    post({
      type: "result",
      jobId: job.request.jobId,
      result: { ...parsed, elapsedMs: Date.now() - startedAt },
    });
  } catch (error) {
    post({
      type: "result",
      jobId: job.request.jobId,
      fatal: true,
      result: {
        ok: false,
        stdout: "",
        value: { kind: "none" },
        elapsedMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      } satisfies PythonExecutionResult,
    });
  } finally {
    py.globals.delete("__stela_code");
    py.globals.delete("__stela_inputs_json");
    py.globals.delete("__stela_query");
    for (const input of [...job.inputs.values(), ...job.fetched.values()]) {
      try {
        py.FS.unlink(input.path);
      } catch {
        // best effort
      }
    }
    try {
      py.FS.rmdir(`/stela-inputs/${job.request.jobId}`);
    } catch {
      // best effort
    }
    active = null;
  }
}

function handle(message: InboundMessage): Promise<void> | void {
  if (message.type === "start") return start(message);
  if (message.type === "chunk") return chunk(message);
  if (message.type === "query-input") return queryInput(message);
  return queryError(message);
}

self.addEventListener("message", (event: MessageEvent<InboundMessage>) => {
  const message = event.data;
  void Promise.resolve(handle(message)).catch((error) => {
    const jobId = message.type === "start" ? message.request.jobId : message.jobId;
    post({
      type: "result",
      jobId,
      fatal: true,
      result: {
        ok: false,
        stdout: "",
        value: { kind: "none" },
        elapsedMs: 0,
        error: error instanceof Error ? error.message : String(error),
      } satisfies PythonExecutionResult,
    });
    active = null;
  });
});
