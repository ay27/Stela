import assert from "node:assert/strict";

import { canMountEChart } from "./echarts-runtime";

function host(isConnected: boolean, clientWidth: number, clientHeight: number): HTMLElement {
  return { isConnected, clientWidth, clientHeight } as HTMLElement;
}

assert.equal(canMountEChart(host(true, 800, 320)), true);
assert.equal(canMountEChart(host(false, 800, 320)), false);
assert.equal(canMountEChart(host(true, 0, 320)), false);
assert.equal(canMountEChart(host(true, 800, 0)), false);

console.log("echarts-runtime tests passed.");
