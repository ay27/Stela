import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { VaultExternalChangePayload } from "@shared/ipc-events";

import {
  notifyFileChanged,
  setBroadcaster,
  start,
  stop,
} from "./vault-watcher";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const root = await mkdtemp(path.join(tmpdir(), "stela-vault-watcher-"));
const events: VaultExternalChangePayload[] = [];

try {
  const notePath = path.join(root, "note.md");
  await writeFile(notePath, "# Before\n", "utf-8");

  setBroadcaster((payload) => {
    events.push(payload);
  });
  await start(root);
  notifyFileChanged(notePath);
  await wait(260);

  assert.equal(events.length, 1);
  assert.equal(events[0]!.vaultPath, root);
  assert.deepEqual(events[0]!.events, [
    { type: "changed", path: notePath, isDir: false },
  ]);
} finally {
  await stop();
  await rm(root, { recursive: true, force: true });
}

console.log("vault-watcher tests passed.");
