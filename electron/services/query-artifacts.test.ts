import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ARTIFACT_IDLE_TTL_MS,
  cleanupQueryArtifacts,
  configureQueryArtifactRoot,
  readQueryArtifactChunk,
  resolveQueryArtifact,
  writeBufferedQueryArtifact,
} from "./query-artifacts";

const root = await mkdtemp(join(tmpdir(), "stela-query-artifacts-"));
try {
  configureQueryArtifactRoot(root);
  const descriptor = await writeBufferedQueryArtifact({
    vaultPath: "/vault/example",
    sessionId: "session-a",
    runId: "run-a",
    columns: [
      { name: "id", typeName: "BIGINT" },
      { name: "label", typeName: "VARCHAR" },
    ],
    rows: [[1n, "first"], [2n, "second"]],
  });
  assert.ok(descriptor);
  assert.equal(descriptor.mode, "jsonl-buffered");
  assert.equal(descriptor.rowCount, 2);
  assert.equal(await resolveQueryArtifact("/vault/example", "session-b", "run-a"), null);

  const chunks: Uint8Array[] = [];
  let offset = 0;
  while (true) {
    const chunk = await readQueryArtifactChunk({
      vaultPath: "/vault/example",
      sessionId: "session-a",
      runId: "run-a",
      offset,
      length: 7,
    });
    chunks.push(chunk.data);
    offset += chunk.data.byteLength;
    if (chunk.eof) break;
  }
  const text = new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
  assert.deepEqual(
    text.trim().split("\n").map((line) => JSON.parse(line)),
    [{ c0: "1", c1: "first" }, { c0: "2", c1: "second" }],
  );

  await cleanupQueryArtifacts(Date.now() + ARTIFACT_IDLE_TTL_MS + 1);
  assert.equal(await resolveQueryArtifact("/vault/example", "session-a", "run-a"), null);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("query-artifacts tests passed.");
