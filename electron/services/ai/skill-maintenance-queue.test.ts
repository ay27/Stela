import assert from "node:assert/strict";
import { mock } from "node:test";
import { setImmediate as flush } from "node:timers/promises";

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

// Synchronous startup failures and async rejections must not escape fire-and-forget
// or prevent a pending job from running. An unhandled rejection fails this process.
for (const sync of [true, false]) {
  let resolveNext!: () => void;
  const next = new Promise<void>(resolve => { resolveNext = resolve; });
  const vault = `failure-${sync}`;
  enqueueSkillMaintenance(vault, sync
    ? () => { throw new Error("startup failure"); }
    : async () => { await flush(); throw new Error("async failure"); }, () => {});
  enqueueSkillMaintenance(vault, async () => { resolveNext(); }, () => {});
  await next;
  await flush();
}

mock.timers.enable({ apis: ["setTimeout"] });
try {
  let timedSignal!: AbortSignal;
  let resolveAfterTimeout!: () => void;
  const afterTimeout = new Promise<void>(resolve => { resolveAfterTimeout = resolve; });
  enqueueSkillMaintenance("timeout-vault", signal => {
    timedSignal = signal;
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }, () => {});
  enqueueSkillMaintenance("timeout-vault", async () => { resolveAfterTimeout(); }, () => {});
  mock.timers.tick(60_000);
  await afterTimeout;
  assert.equal(timedSignal.reason, "timeout");
  await flush();
} finally {
  cancelSkillMaintenance();
  mock.timers.reset();
}
console.log("skill-maintenance queue tests passed");
