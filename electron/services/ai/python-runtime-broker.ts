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

interface PendingJob {
  request: PythonExecutionRequest;
  vaultPath: string;
  sessionId: string;
  artifacts: Map<string, QueryArtifactDescriptor>;
  resolve: (result: PythonExecutionResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
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
  clearTimeout(job.timer);
  if (job.signal && job.onAbort) job.signal.removeEventListener("abort", job.onAbort);
  return job;
}

export async function executePython(input: {
  vaultPath: string;
  sessionId: string;
  code: string;
  artifacts: Record<string, QueryArtifactDescriptor>;
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
  const request: PythonExecutionRequest = { jobId, code: input.code, inputs, timeoutMs };
  return new Promise<PythonExecutionResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      const job = finish(jobId);
      if (!job) return;
      broadcaster?.(IPC_EVENTS.AI_PYTHON_RUNTIME_CANCEL, { jobId });
      reject(new Error(`Python execution timed out after ${timeoutMs}ms`));
    }, timeoutMs + 2_000);
    const job: PendingJob = {
      request,
      vaultPath: input.vaultPath,
      sessionId: input.sessionId,
      artifacts: new Map(Object.entries(input.artifacts)),
      resolve,
      reject,
      timer,
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
    if (!broadcaster?.(IPC_EVENTS.AI_PYTHON_RUNTIME_REQUEST, request)) {
      finish(jobId);
      reject(new Error("Python runtime is unavailable; the renderer is not ready"));
    }
  });
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
