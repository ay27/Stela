/// <reference lib="webworker" />

import { loadPyodide, type PyodideInterface } from "pyodide";

import {
  PYTHON_EXECUTE_SCRIPT,
  STELA_PYODIDE_PACKAGES,
} from "./python-runtime-core";

import type {
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
type InboundMessage = StartMessage | ChunkMessage;

interface ActiveInput {
  path: string;
  stream: ReturnType<PyodideInterface["FS"]["open"]>;
  complete: boolean;
}

interface ActiveJob {
  request: PythonExecutionRequest;
  inputs: Map<string, ActiveInput>;
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
  active = { request: message.request, inputs };
  post({ type: "ready", jobId: message.request.jobId });
  if (inputs.size === 0) await executeActive(py);
}

async function chunk(message: ChunkMessage): Promise<void> {
  const job = active;
  if (!job || job.request.jobId !== message.jobId) return;
  const py = await pyodidePromise!;
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
    await py.runPythonAsync(PYTHON_EXECUTE_SCRIPT);
    const raw = py.globals.get("__stela_result_json");
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
    py.globals.delete("__stela_result_json");
    for (const input of job.inputs.values()) {
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

self.addEventListener("message", (event: MessageEvent<InboundMessage>) => {
  const message = event.data;
  void (message.type === "start" ? start(message) : chunk(message)).catch((error) => {
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
