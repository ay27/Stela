import assert from "node:assert/strict";

import { cancelSkillMaintenance, enqueueSkillMaintenance } from "./skill-maintenance-queue";

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

// 后台 stale-Skill 刷新依赖 cancelSkillMaintenance 能中断在飞的 job。
let refreshSignal!: AbortSignal;
let releaseRefresh!: () => void;
const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
enqueueSkillMaintenance("cancel-vault", async (signal) => {
  refreshSignal = signal;
  await refreshGate;
}, () => {});
assert.equal(refreshSignal.aborted, false);
cancelSkillMaintenance("cancel-vault");
assert.equal(refreshSignal.aborted, true);
releaseRefresh();
