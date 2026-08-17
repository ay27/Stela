import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  configureQueryArtifactRoot,
  writeBufferedQueryArtifact,
} from "../../../electron/services/query-artifacts";
import {
  assertPyodideAssets,
  HeadlessPyodidePool,
} from "./headless-python";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const assetDir = path.join(repoRoot, "node_modules", ".cache", "stela-pyodide");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "stela-headless-python-"));
configureQueryArtifactRoot(path.join(root, "artifacts"));

const vaultPath = path.join(root, "vault");
const sessionId = "session-test";
const left = await writeBufferedQueryArtifact({
  vaultPath,
  sessionId,
  runId: "left-run",
  columns: [{ name: "id", typeName: "BIGINT" }, { name: "amount", typeName: "BIGINT" }],
  rows: [[1, 10], [2, 20]],
});
const right = await writeBufferedQueryArtifact({
  vaultPath,
  sessionId,
  runId: "right-run",
  columns: [{ name: "id", typeName: "BIGINT" }, { name: "weight", typeName: "BIGINT" }],
  rows: [[1, 2], [2, 3]],
});
assert.ok(left && right);

await assertPyodideAssets(assetDir);
const pool = new HeadlessPyodidePool(assetDir, 1);
try {
  const result = await pool.execute({
    vaultPath,
    sessionId,
    artifacts: { left, right },
    code: `result = con.sql('SELECT SUM(l.amount * r.weight) FROM "left" l JOIN "right" r USING (id)').fetchone()[0]`,
  });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.value, { kind: "scalar", value: 80 });

  const isolation = await pool.execute({
    vaultPath,
    sessionId,
    artifacts: {},
    code: "import js, os\nresult = {'node_process': hasattr(js, 'process'), 'host_passwd': os.path.exists('/etc/passwd')}",
  });
  assert.equal(isolation.ok, true, isolation.error);
  assert.deepEqual(isolation.value, {
    kind: "scalar",
    value: { node_process: false, host_passwd: false },
  });

  const failed = await pool.execute({
    vaultPath,
    sessionId,
    artifacts: { left },
    code: "raise ValueError('bounded failure')",
  });
  assert.equal(failed.ok, false);
  assert.match(failed.error ?? "", /bounded failure/);

  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(
    pool.execute({
      vaultPath,
      sessionId,
      artifacts: { left },
      code: "result = 1",
      signal: cancelled.signal,
    }),
    /cancelled/,
  );
} finally {
  await pool.close();
  await fs.rm(root, { recursive: true, force: true });
}

console.log("headless Pyodide evaluation tests passed.");
