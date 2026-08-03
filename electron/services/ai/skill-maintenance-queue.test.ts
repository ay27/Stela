import assert from "node:assert/strict";

import { enqueueSkillMaintenance } from "./skill-maintenance-queue";

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
