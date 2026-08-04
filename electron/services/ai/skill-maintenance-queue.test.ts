import assert from "node:assert/strict";

import {
  cancelSkillMaintenance,
  enqueueSkillMaintenance,
  registerSkillMaintenanceActivity,
} from "./skill-maintenance-queue";

let releaseFirst!: () => void;
const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
let secondDropped = false;
let resolveThird!: () => void;
const thirdDone = new Promise<void>((resolve) => { resolveThird = resolve; });
const order: string[] = [];

enqueueSkillMaintenance("test-vault", async () => {
  order.push("first-start");
  await firstGate;
  order.push("first-end");
}, () => {});
enqueueSkillMaintenance("test-vault", async () => {
  order.push("second");
}, () => { secondDropped = true; });
enqueueSkillMaintenance("test-vault", async () => {
  order.push("third");
  resolveThird();
}, () => {});

releaseFirst();
await thirdDone;
assert.equal(secondDropped, true);
assert.deepEqual(order, ["first-start", "first-end", "third"]);

const parent = new AbortController();
const activity = registerSkillMaintenanceActivity("refresh-vault", parent.signal);
assert.equal(activity.signal.aborted, false);
cancelSkillMaintenance("refresh-vault");
assert.equal(activity.signal.aborted, true);
activity.dispose();
