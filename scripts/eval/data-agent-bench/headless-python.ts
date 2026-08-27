import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";

import type {
  PythonExecutionInput,
  PythonExecutionRequest,
  PythonExecutionResult,
} from "@shared/types";
import { readQueryArtifactChunk } from "../../../electron/services/query-artifacts";
import type { AgentPythonExecutorOps } from "../../../electron/services/ai/agent-tools";
import {
  PYTHON_EXECUTE_SCRIPT,
  STELA_PYODIDE_PACKAGES,
} from "../../../src/services/python-runtime-core";

const CHUNK_BYTES = 4 * 1024 * 1024;
const EXECUTION_TIMEOUT_MS = 60_000;

/**
 * Same budgets as the product broker: the timer measures inactivity, so each
 * served query refreshes it, and MAX_TOTAL_MS is the ceiling refreshing cannot
 * lift. See electron/services/ai/python-runtime-broker.ts.
 */
const MAX_TOTAL_MS = 10 * 60 * 1000;
const MAX_QUERIES_PER_JOB = 32;

type WorkerMessage =
  | { type: "initialized" }
  | { type: "ready"; jobId: string }
  | { type: "query"; jobId: string; requestId: string; connectionName: string; request: string }
  | { type: "result"; jobId: string; result: PythonExecutionResult; fatal?: boolean }
  | { type: "fatal"; jobId: string | null; error: string };

export async function assertPyodideAssets(assetDir: string): Promise<void> {
  const required = ["pyodide.asm.mjs", "pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json"];
  await Promise.all(required.map((name) => fs.access(path.join(assetDir, name))));
  const lock = JSON.parse(await fs.readFile(path.join(assetDir, "pyodide-lock.json"), "utf8")) as {
    packages?: Record<string, { file_name?: string }>;
  };
  const packageFiles = STELA_PYODIDE_PACKAGES.map((name) => {
    const fileName = lock.packages?.[name]?.file_name;
    if (!fileName) throw new Error(`Pyodide asset lock does not contain '${name}'.`);
    return fs.access(path.join(assetDir, fileName));
  });
  await Promise.all(packageFiles);
}

class PyodideSlot {
  private worker: Worker | null = null;
  private initialized: Promise<void> | null = null;
  private terminating: Promise<number> | null = null;

  constructor(private readonly assetDir: string) {}

  private reset(): void {
    const worker = this.worker;
    if (worker) {
      const terminating = worker.terminate();
      this.terminating = terminating;
      void terminating.finally(() => {
        if (this.terminating === terminating) this.terminating = null;
      });
    }
    this.worker = null;
    this.initialized = null;
  }

  private async ensureWorker(): Promise<void> {
    if (this.terminating) await this.terminating;
    if (this.initialized) return this.initialized;
    const worker = new Worker(new URL("./pyodide-worker.mjs", import.meta.url), {
      workerData: {
        assetDir: this.assetDir,
        executeScript: PYTHON_EXECUTE_SCRIPT,
        packages: [...STELA_PYODIDE_PACKAGES],
      },
    });
    this.worker = worker;
    this.initialized = new Promise<void>((resolve, reject) => {
      const onMessage = (message: WorkerMessage): void => {
        if (message.type === "initialized") {
          cleanup();
          resolve();
        } else if (message.type === "fatal" && message.jobId === null) {
          cleanup();
          this.reset();
          reject(new Error(`Pyodide initialization failed: ${message.error}`));
        }
      };
      const onError = (error: Error): void => {
        cleanup();
        this.reset();
        reject(error);
      };
      const onExit = (code: number): void => {
        if (code === 0) return;
        cleanup();
        this.reset();
        reject(new Error(`Pyodide worker exited with code ${code}.`));
      };
      const cleanup = (): void => {
        worker.off("message", onMessage);
        worker.off("error", onError);
        worker.off("exit", onExit);
      };
      worker.on("message", onMessage);
      worker.once("error", onError);
      worker.once("exit", onExit);
    });
    return this.initialized;
  }

  async execute(input: Parameters<AgentPythonExecutorOps["execute"]>[0]): Promise<PythonExecutionResult> {
    await this.ensureWorker();
    const worker = this.worker;
    if (!worker) throw new Error("Pyodide worker is unavailable.");
    const jobId = randomUUID();
    const request: PythonExecutionRequest = {
      jobId,
      code: input.code,
      timeoutMs: EXECUTION_TIMEOUT_MS,
      canQuery: Boolean(input.runQuery),
      inputs: Object.entries(input.artifacts).map(([alias, artifact]) => ({
        alias,
        runId: artifact.runId,
        format: artifact.format,
        columns: artifact.columns,
        rowCount: artifact.rowCount,
        byteSize: artifact.byteSize,
      })),
    };
    const deadlineAt = Date.now() + (input.runQuery ? MAX_TOTAL_MS : EXECUTION_TIMEOUT_MS);
    let queryCount = 0;

    return new Promise<PythonExecutionResult>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      const finish = (callback: () => void, reset = false): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", onAbort);
        worker.off("message", onMessage);
        worker.off("error", onError);
        worker.off("exit", onExit);
        if (reset) this.reset();
        callback();
      };
      const fail = (error: Error, reset = true): void => finish(() => reject(error), reset);
      const armTimer = (): void => {
        clearTimeout(timer);
        const slice = EXECUTION_TIMEOUT_MS + 2_000;
        const remaining = deadlineAt - Date.now();
        const totalExhausted = remaining <= slice;
        timer = setTimeout(
          () =>
            fail(
              new Error(
                totalExhausted
                  ? `Python execution exceeded the ${Math.round(MAX_TOTAL_MS / 1000)}s total budget`
                  : `Python execution timed out after ${EXECUTION_TIMEOUT_MS}ms without progress`,
              ),
            ),
          Math.max(0, Math.min(slice, remaining)),
        );
      };
      const streamArtifact = async (alias: string, runId: string): Promise<void> => {
        let offset = 0;
        while (true) {
          if (input.signal?.aborted) throw new Error("Python execution cancelled");
          const chunk = await readQueryArtifactChunk({
            vaultPath: input.vaultPath,
            sessionId: input.sessionId,
            runId,
            offset,
            length: CHUNK_BYTES,
          });
          const data = chunk.data.slice();
          offset += data.byteLength;
          worker.postMessage(
            { type: "chunk", jobId, alias, data: data.buffer, eof: chunk.eof },
            [data.buffer],
          );
          if (chunk.eof) return;
        }
      };
      const stream = async (): Promise<void> => {
        for (const item of request.inputs) await streamArtifact(item.alias, item.runId);
      };
      const serveQuery = async (
        message: Extract<WorkerMessage, { type: "query" }>,
      ): Promise<void> => {
        const reply = (payload: Record<string, unknown>): void =>
          worker.postMessage({ jobId, requestId: message.requestId, ...payload });
        let descriptor: PythonExecutionInput;
        try {
          if (!input.runQuery) throw new Error("This Python job cannot query data connections");
          queryCount += 1;
          if (queryCount > MAX_QUERIES_PER_JOB) {
            throw new Error(
              `query() is limited to ${MAX_QUERIES_PER_JOB} calls per execution; aggregate in SQL instead of looping`,
            );
          }
          // Issuing a query is progress too; see the product broker.
          armTimer();
          const artifact = await input.runQuery({
            connectionName: message.connectionName,
            request: message.request,
          });
          descriptor = {
            alias: `q${queryCount}`,
            runId: artifact.runId,
            format: artifact.format,
            columns: artifact.columns,
            rowCount: artifact.rowCount,
            byteSize: artifact.byteSize,
          };
        } catch (error) {
          reply({ type: "query-error", error: error instanceof Error ? error.message : String(error) });
          return;
        }
        reply({ type: "query-input", input: descriptor });
        try {
          await streamArtifact(descriptor.alias, descriptor.runId);
          armTimer();
        } catch (error) {
          reply({ type: "query-error", error: error instanceof Error ? error.message : String(error) });
        }
      };
      const onMessage = (message: WorkerMessage): void => {
        if (message.type === "ready" && message.jobId === jobId) {
          void stream().catch((error) => fail(error instanceof Error ? error : new Error(String(error))));
        } else if (message.type === "query" && message.jobId === jobId) {
          void serveQuery(message).catch((error) =>
            fail(error instanceof Error ? error : new Error(String(error))),
          );
        } else if (message.type === "result" && message.jobId === jobId) {
          finish(() => resolve(message.result), message.fatal === true);
        } else if (message.type === "fatal" && (message.jobId === null || message.jobId === jobId)) {
          fail(new Error(message.error));
        }
      };
      const onError = (error: Error): void => fail(error);
      const onExit = (code: number): void => fail(new Error(`Pyodide worker exited with code ${code}.`));
      const onAbort = (): void => fail(new Error("Python execution cancelled"));
      armTimer();
      worker.on("message", onMessage);
      worker.once("error", onError);
      worker.once("exit", onExit);
      input.signal?.addEventListener("abort", onAbort, { once: true });
      if (input.signal?.aborted) {
        onAbort();
        return;
      }
      worker.postMessage({ type: "start", request });
    });
  }

  async close(): Promise<void> {
    this.reset();
    if (this.terminating) await this.terminating;
  }
}

interface PoolWaiter {
  resolve: (slot: PyodideSlot) => void;
  reject: (error: Error) => void;
}

export class HeadlessPyodidePool implements AgentPythonExecutorOps {
  private readonly slots: PyodideSlot[];
  private readonly available: PyodideSlot[];
  private readonly waiters: PoolWaiter[] = [];
  private closed = false;

  constructor(assetDir: string, concurrency: number) {
    this.slots = Array.from(
      { length: Math.max(1, Math.floor(concurrency)) },
      () => new PyodideSlot(assetDir),
    );
    this.available = [...this.slots];
  }

  private acquire(): Promise<PyodideSlot> {
    if (this.closed) return Promise.reject(new Error("Pyodide pool is closed."));
    const slot = this.available.shift();
    if (slot) return Promise.resolve(slot);
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  private release(slot: PyodideSlot): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve(slot);
    else if (!this.closed) this.available.push(slot);
    else void slot.close();
  }

  async execute(input: Parameters<AgentPythonExecutorOps["execute"]>[0]): Promise<PythonExecutionResult> {
    const slot = await this.acquire();
    try {
      return await slot.execute(input);
    } finally {
      this.release(slot);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter.reject(new Error("Pyodide pool is closed."));
    this.available.splice(0);
    await Promise.all(this.slots.map((slot) => slot.close()));
  }
}
