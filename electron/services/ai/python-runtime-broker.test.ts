/**
 * Sandbox `query()` authorization in the broker: a call is only served while its
 * job is live, results become aliases that the existing artifact read path
 * authorizes, and the per-execution call budget holds.
 */

import assert from "node:assert/strict";

import type { PythonExecutionRequest, QueryArtifactDescriptor } from "@shared/types";
import { IPC_EVENTS } from "@shared/ipc-events";

import {
  cancelAllPythonRuntimeJobs,
  executePython,
  queryForPythonJob,
  readPythonRuntimeInput,
  respondPythonRuntime,
  setPythonRuntimeBroadcaster,
} from "./python-runtime-broker";

function descriptor(runId: string): QueryArtifactDescriptor {
  return {
    runId,
    sessionId: "session-1",
    format: "jsonl",
    mode: "jsonl-buffered",
    columns: [{ name: "value", typeName: "BIGINT" }],
    rowCount: 2,
    byteSize: 12,
    createdAt: 1,
    lastAccessedAt: 1,
  };
}

let started: PythonExecutionRequest | null = null;
setPythonRuntimeBroadcaster((channel, payload) => {
  if (channel === IPC_EVENTS.AI_PYTHON_RUNTIME_REQUEST) {
    started = payload as PythonExecutionRequest;
  }
  return true;
});

// A job granted a runner advertises canQuery and serves calls under generated
// aliases; unrelated aliases stay unauthorized.
{
  const requests: string[] = [];
  let jobId = "";
  const pending = executePython({
    vaultPath: "/vault",
    sessionId: "session-1",
    code: "result = 1",
    artifacts: {},
    runQuery: async ({ connectionName, request }) => {
      requests.push(`${connectionName}:${request}`);
      return descriptor(`run-${requests.length}`);
    },
  });
  assert.ok(started, "the request reached the renderer");
  assert.equal(started.canQuery, true);
  jobId = started.jobId;

  const first = await queryForPythonJob({
    jobId,
    connectionName: "warehouse",
    request: JSON.stringify({ language: "sql", query: "SELECT 1" }),
  });
  assert.equal(first.alias, "q1");
  assert.equal(first.runId, "run-1");
  const second = await queryForPythonJob({
    jobId,
    connectionName: "crm",
    request: JSON.stringify({ language: "sql", query: "SELECT 2" }),
  });
  assert.equal(second.alias, "q2", "aliases must not collide within one execution");
  assert.deepEqual(requests, [
    'warehouse:{"language":"sql","query":"SELECT 1"}',
    'crm:{"language":"sql","query":"SELECT 2"}',
  ]);

  // Registering the alias is what makes the existing chunk read authorized; an
  // alias the sandbox invents is not.
  await assert.rejects(
    readPythonRuntimeInput({ jobId, alias: "q9", offset: 0, length: 1 }),
    /not authorized/,
  );

  assert.deepEqual(respondPythonRuntime({
    jobId,
    result: { ok: true, stdout: "", value: { kind: "none" }, elapsedMs: 1 },
  }), { accepted: true });
  const settled = await pending;
  assert.equal(settled.ok, true);

  // After the job settles the RPC is closed, so a straggler cannot query.
  await assert.rejects(
    queryForPythonJob({ jobId, connectionName: "warehouse", request: "{}" }),
    /no longer active/,
  );
}

// Without a runner the capability is absent, not merely unused.
{
  started = null;
  const pending = executePython({
    vaultPath: "/vault",
    sessionId: "session-1",
    code: "result = 1",
    artifacts: {},
  });
  assert.ok(started);
  assert.equal(started.canQuery, false);
  await assert.rejects(
    queryForPythonJob({
      jobId: started.jobId,
      connectionName: "warehouse",
      request: "{}",
    }),
    /cannot query data connections/,
  );
  respondPythonRuntime({
    jobId: started.jobId,
    result: { ok: true, stdout: "", value: { kind: "none" }, elapsedMs: 1 },
  });
  await pending;
}

// The per-execution call budget stops a model that loops on the database.
{
  started = null;
  const pending = executePython({
    vaultPath: "/vault",
    sessionId: "session-1",
    code: "result = 1",
    artifacts: {},
    runQuery: async () => descriptor("run-loop"),
  });
  assert.ok(started);
  const jobId = started.jobId;
  const request = JSON.stringify({ language: "sql", query: "SELECT 1" });
  let served = 0;
  let refusal = "";
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await queryForPythonJob({ jobId, connectionName: "warehouse", request });
      served += 1;
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
      break;
    }
  }
  assert.equal(served, 32);
  assert.match(refusal, /limited to 32 calls/);
  respondPythonRuntime({
    jobId,
    result: { ok: true, stdout: "", value: { kind: "none" }, elapsedMs: 1 },
  });
  await pending;
}

cancelAllPythonRuntimeJobs();
setPythonRuntimeBroadcaster(null);
console.log("python runtime broker tests passed.");
