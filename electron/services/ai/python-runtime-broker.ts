/** Main-process broker between Agent tools and the app-owned renderer Worker. */

import { randomUUID } from "node:crypto";

import type {
  PythonExecutionInput,
  PythonExecutionRequest,
  PythonExecutionResult,
  PythonRuntimeInputChunk,
  QueryArtifactDescriptor,
} from "@shared/types";
import { IPC_EVENTS, type IpcEventChannel } from "@shared/ipc-events";

import { readQueryArtifactChunk } from "../query-artifacts";

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Sandbox `query()` budgets. The per-slice timer only measures inactivity: each
 * completed query refreshes it, because a slow database is progress, not a hang.
 * `MAX_TOTAL_MS` is the wall clock that refreshing cannot extend.
 */
const MAX_TOTAL_MS = 10 * 60 * 1000;
const MAX_QUERIES_PER_JOB = 32;
const MAX_QUERY_BYTES_PER_JOB = 2 * 1024 * 1024 * 1024;

/**
 * Runs one read-only query on the user's behalf and returns its session
 * artifact. Supplied by the Agent tool layer, which owns connection resolution,
 * sql-guard, and the execution journal; the broker never sees credentials.
 */
export type PythonJobQueryRunner = (input: {
  connectionName: string;
  /** JSON-encoded DataQueryRequest authored by the sandbox. */
  request: string;
}) => Promise<QueryArtifactDescriptor>;

interface PendingJob {
  request: PythonExecutionRequest;
  vaultPath: string;
  sessionId: string;
  artifacts: Map<string, QueryArtifactDescriptor>;
  resolve: (result: PythonExecutionResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  sliceMs: number;
  deadlineAt: number;
  queryCount: number;
  queryAliasCounter: number;
  queryBytes: number;
  runQuery?: PythonJobQueryRunner;
  signal?: AbortSignal;
  onAbort?: () => void;
}

type Broadcaster = (channel: IpcEventChannel, payload: unknown) => boolean;

let broadcaster: Broadcaster | null = null;
const pending = new Map<string, PendingJob>();

export function setPythonRuntimeBroadcaster(next: Broadcaster | null): void {
  broadcaster = next;
}

function finish(jobId: string): PendingJob | null {
  const job = pending.get(jobId) ?? null;
  if (!job) return null;
  pending.delete(jobId);
  if (job.timer) clearTimeout(job.timer);
  if (job.signal && job.onAbort) job.signal.removeEventListener("abort", job.onAbort);
  return job;
}

function armTimer(jobId: string, job: PendingJob): void {
  if (job.timer) clearTimeout(job.timer);
  const slice = job.sliceMs + 2_000;
  const remaining = job.deadlineAt - Date.now();
  const totalExhausted = remaining <= slice;
  job.timer = setTimeout(() => {
    const active = finish(jobId);
    if (!active) return;
    broadcaster?.(IPC_EVENTS.AI_PYTHON_RUNTIME_CANCEL, { jobId });
    active.reject(
      new Error(
        totalExhausted
          ? `Python execution exceeded the ${Math.round(MAX_TOTAL_MS / 1000)}s total budget`
          : `Python execution timed out after ${job.sliceMs}ms without progress`,
      ),
    );
  }, Math.max(0, Math.min(slice, remaining)));
}

export async function executePython(input: {
  vaultPath: string;
  sessionId: string;
  code: string;
  artifacts: Record<string, QueryArtifactDescriptor>;
  runQuery?: PythonJobQueryRunner;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<PythonExecutionResult> {
  if (!broadcaster) throw new Error("Python runtime is unavailable; the renderer is not ready");
  if (input.signal?.aborted) throw new Error("Python execution cancelled");
  const jobId = randomUUID();
  const timeoutMs = Math.min(60_000, Math.max(1_000, input.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const inputs: PythonExecutionInput[] = Object.entries(input.artifacts).map(([alias, artifact]) => ({
    alias,
    runId: artifact.runId,
    format: artifact.format,
    columns: artifact.columns,
    rowCount: artifact.rowCount,
    byteSize: artifact.byteSize,
  }));
  const inputBytes = inputs.reduce((total, item) => total + item.byteSize, 0);
  if (inputs.length > MAX_QUERIES_PER_JOB) {
    throw new Error(`execute_python supports at most ${MAX_QUERIES_PER_JOB} total sources and dynamic queries`);
  }
  if (inputBytes > MAX_QUERY_BYTES_PER_JOB) {
    throw new Error("execute_python sources exceed the total bytes budget for one execution");
  }
  const request: PythonExecutionRequest = {
    jobId,
    code: input.code,
    inputs,
    timeoutMs,
    canQuery: Boolean(input.runQuery),
  };
  return new Promise<PythonExecutionResult>((resolve, reject) => {
    const job: PendingJob = {
      request,
      vaultPath: input.vaultPath,
      sessionId: input.sessionId,
      artifacts: new Map(Object.entries(input.artifacts)),
      resolve,
      reject,
      timer: null,
      sliceMs: timeoutMs,
      deadlineAt: Date.now() + (input.runQuery ? MAX_TOTAL_MS : timeoutMs),
      queryCount: inputs.length,
      queryAliasCounter: 0,
      queryBytes: inputBytes,
      runQuery: input.runQuery,
      signal: input.signal,
    };
    if (input.signal) {
      job.onAbort = () => {
        const active = finish(jobId);
        if (!active) return;
        broadcaster?.(IPC_EVENTS.AI_PYTHON_RUNTIME_CANCEL, { jobId });
        reject(new Error("Python execution cancelled"));
      };
      input.signal.addEventListener("abort", job.onAbort, { once: true });
    }
    pending.set(jobId, job);
    armTimer(jobId, job);
    if (!broadcaster?.(IPC_EVENTS.AI_PYTHON_RUNTIME_REQUEST, request)) {
      finish(jobId);
      reject(new Error("Python runtime is unavailable; the renderer is not ready"));
    }
  });
}

/**
 * Serve one `await query(connection, sql)` from inside the sandbox.
 *
 * Authorization mirrors {@link readPythonRuntimeInput}: the job must still be
 * active, and only a connection *name* crosses the process boundary. The
 * resulting artifact is registered under a generated alias so the existing
 * chunk-streaming path can carry it into the sandbox unchanged.
 */
export async function queryForPythonJob(input: {
  jobId: string;
  connectionName: string;
  request: string;
}): Promise<PythonExecutionInput> {
  const job = pending.get(input.jobId);
  if (!job) throw new Error("Python runtime job is no longer active");
  if (!job.runQuery) throw new Error("This Python job cannot query data connections");
  if (job.queryCount >= MAX_QUERIES_PER_JOB) {
    throw new Error(
      `query() is limited to ${MAX_QUERIES_PER_JOB} calls per execution; aggregate in SQL instead of looping`,
    );
  }
  job.queryCount += 1;
  // Issuing a query is progress, so the inactivity timer resets before the wait
  // as well as after it; otherwise one slow database kills the whole job.
  armTimer(input.jobId, job);
  const artifact = await job.runQuery({
    connectionName: input.connectionName,
    request: input.request,
  });
  if (!pending.has(input.jobId)) throw new Error("Python runtime job is no longer active");
  job.queryBytes += artifact.byteSize;
  if (job.queryBytes > MAX_QUERY_BYTES_PER_JOB) {
    throw new Error("query() exceeded the total bytes budget for one execution; select fewer columns");
  }
  let alias: string;
  do {
    job.queryAliasCounter += 1;
    alias = `q${job.queryAliasCounter}`;
  } while (job.artifacts.has(alias));
  job.artifacts.set(alias, artifact);
  armTimer(input.jobId, job);
  return {
    alias,
    runId: artifact.runId,
    format: artifact.format,
    columns: artifact.columns,
    rowCount: artifact.rowCount,
    byteSize: artifact.byteSize,
  };
}

export async function readPythonRuntimeInput(input: {
  jobId: string;
  alias: string;
  offset: number;
  length: number;
}): Promise<PythonRuntimeInputChunk> {
  const job = pending.get(input.jobId);
  if (!job) throw new Error("Python runtime job is no longer active");
  const artifact = job.artifacts.get(input.alias);
  if (!artifact) throw new Error(`Python input alias '${input.alias}' is not authorized`);
  return readQueryArtifactChunk({
    vaultPath: job.vaultPath,
    sessionId: job.sessionId,
    runId: artifact.runId,
    offset: input.offset,
    length: input.length,
  });
}

export function respondPythonRuntime(input: {
  jobId: string;
  result: PythonExecutionResult;
}): { accepted: boolean } {
  const job = finish(input.jobId);
  if (!job) return { accepted: false };
  job.resolve(input.result);
  return { accepted: true };
}

export function cancelAllPythonRuntimeJobs(reason = "Python runtime stopped"): void {
  for (const jobId of [...pending.keys()]) {
    const job = finish(jobId);
    if (!job) continue;
    job.reject(new Error(reason));
  }
}
