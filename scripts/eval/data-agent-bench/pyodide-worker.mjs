import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";

import { loadPyodide } from "pyodide";

if (!parentPort) throw new Error("Pyodide evaluation worker requires parentPort");

const { assetDir, executeScript, packages } = workerData;
let pyodide;
let active = null;

function inputPath(jobId, alias, format) {
  return `/stela-inputs/${jobId}/${alias}.${format === "parquet" ? "parquet" : "jsonl"}`;
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
    await pyodide.runPythonAsync(executeScript);
    const raw = pyodide.globals.get("__stela_result_json");
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
    for (const key of ["__stela_code", "__stela_inputs_json", "__stela_result_json"]) {
      pyodide.globals.delete(key);
    }
    for (const input of job.inputs.values()) {
      try { pyodide.FS.unlink(input.path); } catch {}
    }
    try { pyodide.FS.rmdir(`/stela-inputs/${job.request.jobId}`); } catch {}
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
  active = { request, inputs };
  parentPort.postMessage({ type: "ready", jobId: request.jobId });
  if (inputs.size === 0) await executeActive();
}

async function chunk(message) {
  const job = active;
  if (!job || job.request.jobId !== message.jobId) return;
  const input = job.inputs.get(message.alias);
  if (!input || input.complete) return;
  const data = new Uint8Array(message.data);
  if (data.byteLength > 0) pyodide.FS.write(input.stream, data, 0, data.byteLength);
  if (message.eof) {
    pyodide.FS.close(input.stream);
    input.complete = true;
  }
  if ([...job.inputs.values()].every((item) => item.complete)) await executeActive();
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
    Promise.resolve(message.type === "start" ? start(message.request) : chunk(message)).catch((error) => {
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
