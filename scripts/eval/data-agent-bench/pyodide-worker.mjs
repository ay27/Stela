import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";

import { loadPyodide } from "pyodide";

if (!parentPort) throw new Error("Pyodide evaluation worker requires parentPort");

const { assetDir, executeScript, packages } = workerData;
let pyodide;
let active = null;
let retainedBytes = 0;
const semanticPending = new Map();
function requestSemantic(request) {
  const job = active;
  if (!job?.request.canSemantic) return Promise.reject(new Error("Semantic execution is unavailable"));
  const requestId = 's' + (++job.queryCounter);
  return new Promise((resolve, reject) => {
    semanticPending.set(requestId, { resolve, reject });
    parentPort.postMessage({ type: "semantic", jobId: job.request.jobId, requestId, request: String(request) });
  });
}

function inputPath(jobId, alias, format) {
  return `/stela-inputs/${jobId}/${alias}.${format === "parquet" ? "parquet" : "jsonl"}`;
}

/** The one JS callable handed to Python; see src/services/python-runtime-core.ts. */
function requestQuery(connectionName, request) {
  const job = active;
  if (!job) return Promise.reject(new Error("Pyodide worker has no active job"));
  if (!job.request.canQuery) return Promise.reject(new Error("query() is unavailable in this execution; no data connection was granted"));
  job.queryCounter += 1;
  const requestId = `r${job.queryCounter}`;
  return new Promise((resolve, reject) => {
    job.pendingQueries.set(requestId, { resolve, reject, alias: "" });
    parentPort.postMessage({
      type: "query",
      jobId: job.request.jobId,
      requestId,
      connectionName: String(connectionName),
      request: String(request),
    });
  });
}

async function executeActive() {
  const job = active;
  if (!job) return;
  const startedAt = Date.now();
  try {
    const config = job.request.inputs.map((input) => ({
      ...input,
      path: job.inputs.get(input.alias).path,
    }));
    pyodide.globals.set("__stela_code", job.request.code);
    pyodide.globals.set("__stela_inputs_json", JSON.stringify(config));
    pyodide.globals.set("__stela_query", requestQuery);
    pyodide.globals.set("__stela_semantic", requestSemantic);
    const raw = await pyodide.runPythonAsync(executeScript);
    const parsed = JSON.parse(String(raw));
    raw?.destroy?.();
    parentPort.postMessage({
      type: "result",
      jobId: job.request.jobId,
      result: { ...parsed, elapsedMs: Date.now() - startedAt },
    });
  } catch (error) {
    parentPort.postMessage({
      type: "result",
      jobId: job.request.jobId,
      fatal: true,
      result: {
        ok: false,
        stdout: "",
        value: { kind: "none" },
        elapsedMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      },
    });
  } finally {
    for (const key of ["__stela_code", "__stela_inputs_json", "__stela_query", "__stela_semantic"]) {
      pyodide.globals.delete(key);
    }
    for (const pending of semanticPending.values()) pending.reject(new Error("Python job finished"));
    semanticPending.clear();
    // Inputs remain alive with their workspace's lazy relations.
    active = null;
  }
}

async function start(request) {
  if (active) throw new Error("Pyodide evaluation worker is busy");
  pyodide.FS.mkdirTree(`/stela-inputs/${request.jobId}`);
  const inputs = new Map();
  for (const input of request.inputs) {
    const filePath = inputPath(request.jobId, input.alias, input.format);
    inputs.set(input.alias, {
      path: filePath,
      stream: pyodide.FS.open(filePath, "w"),
      complete: false,
    });
  }
  active = {
    request,
    inputs,
    fetched: new Map(),
    pendingQueries: new Map(),
    queriesByAlias: new Map(),
    descriptors: new Map(),
    queryCounter: 0,
  };
  parentPort.postMessage({ type: "ready", jobId: request.jobId });
  if (inputs.size === 0) await executeActive();
}

function queryInput(message) {
  const job = active;
  if (!job || job.request.jobId !== message.jobId) return;
  const pendingQuery = job.pendingQueries.get(message.requestId);
  if (!pendingQuery) return;
  pendingQuery.alias = message.input.alias;
  job.queriesByAlias.set(message.input.alias, message.requestId);
  job.descriptors.set(message.input.alias, message.input);
}

function queryError(message) {
  const job = active;
  if (!job || job.request.jobId !== message.jobId) return;
  const pendingQuery = job.pendingQueries.get(message.requestId);
  if (!pendingQuery) return;
  job.pendingQueries.delete(message.requestId);
  if (pendingQuery.alias) job.queriesByAlias.delete(pendingQuery.alias);
  pendingQuery.reject(new Error(message.error));
}

async function chunk(message) {
  const job = active;
  if (!job || job.request.jobId !== message.jobId) return;
  const data = new Uint8Array(message.data);
  retainedBytes += data.byteLength;
  if (retainedBytes > 2 * 1024 ** 3) throw new Error("workspace_lost: workspace input limit exceeded");
  const requestId = job.queriesByAlias.get(message.alias);
  if (requestId) {
    let target = job.fetched.get(message.alias);
    if (!target) {
      const descriptor = job.descriptors.get(message.alias);
      const filePath = inputPath(message.jobId, message.alias, descriptor.format);
      target = { path: filePath, stream: pyodide.FS.open(filePath, "w"), complete: false };
      job.fetched.set(message.alias, target);
    }
    if (target.complete) return;
    if (data.byteLength > 0) pyodide.FS.write(target.stream, data, 0, data.byteLength);
    if (!message.eof) return;
    pyodide.FS.close(target.stream);
    target.complete = true;
    const pendingQuery = job.pendingQueries.get(requestId);
    job.pendingQueries.delete(requestId);
    job.queriesByAlias.delete(message.alias);
    pendingQuery?.resolve(
      JSON.stringify({ ...job.descriptors.get(message.alias), path: target.path }),
    );
    return;
  }
  const input = job.inputs.get(message.alias);
  if (!input || input.complete) return;
  if (data.byteLength > 0) pyodide.FS.write(input.stream, data, 0, data.byteLength);
  if (message.eof) {
    pyodide.FS.close(input.stream);
    input.complete = true;
  }
  if ([...job.inputs.values()].every((item) => item.complete)) await executeActive();
}

function handle(message) {
  if (message.type === "semantic-result") {
    if (active?.request.jobId !== message.jobId) return;
    const pending = semanticPending.get(message.requestId);
    semanticPending.delete(message.requestId);
    if (message.error) pending?.reject(new Error(message.error));
    else pending?.resolve(message.result ?? "{}");
    return;
  }
  if (message.type === "start") return start(message.request);
  if (message.type === "chunk") return chunk(message);
  if (message.type === "query-input") return queryInput(message);
  if (message.type === "query-error") return queryError(message);
  return undefined;
}

try {
  const base = assetDir.endsWith(path.sep) ? assetDir : assetDir + path.sep;
  pyodide = await loadPyodide({
    indexURL: base,
    packageBaseUrl: base,
    lockFileURL: path.join(assetDir, "pyodide-lock.json"),
    packages,
    jsglobals: Object.freeze({}),
    stdout: () => {},
    stderr: () => {},
  });
  parentPort.postMessage({ type: "initialized" });
  parentPort.on("message", (message) => {
    Promise.resolve(handle(message)).catch((error) => {
      parentPort.postMessage({
        type: "fatal",
        jobId: message.request?.jobId ?? message.jobId ?? null,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });
} catch (error) {
  parentPort.postMessage({
    type: "fatal",
    jobId: null,
    error: error instanceof Error ? error.message : String(error),
  });
}
