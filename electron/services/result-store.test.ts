/**
 * result-store 单测：聚焦 listRunsByBlockId 的过滤 / 排序 / 分页。
 *
 * better-sqlite3 是 electron 原生模块，需在 electron runtime 下跑：
 *
 *     ELECTRON_RUN_AS_NODE=1 electron --import tsx electron/services/result-store.test.ts
 *
 * 已挂在 `npm run test:sync`。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as resultStore from "./result-store";
import type { RunRecord } from "@shared/types";

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

function expect(name: string, ok: boolean, detail?: string): Check {
  return { name, ok, detail };
}

function run(
  runId: string,
  blockId: string,
  startedAt: number,
  status: "ok" | "err" = "ok",
): RunRecord {
  return {
    runId,
    blockId,
    sql: "SELECT 1",
    status,
    message: status === "err" ? "boom" : null,
    startedAt,
    elapsedMs: 5,
    rowCount: status === "ok" ? 1 : 0,
    connectionName: "test-conn",
    notePath: null,
  };
}

async function main(): Promise<void> {
  const vault = await mkdtemp(join(tmpdir(), "stela-resultstore-"));
  const checks: Check[] = [];

  try {
    await resultStore.open(vault);

    // blockA：3 次 ok + 1 次 err，时间递增；blockB：1 次 ok
    resultStore.saveRun(run("a1", "blockA", 1000));
    resultStore.saveRun(run("a2", "blockA", 2000));
    resultStore.saveRun(run("a3", "blockA", 3000));
    resultStore.saveRun(run("a4", "blockA", 4000, "err"));
    resultStore.saveRun(run("b1", "blockB", 1500));

    const byA = resultStore.listRunsByBlockId("blockA");
    checks.push(
      expect("blockA 返回 4 条", byA.length === 4, `got ${byA.length}`),
    );
    checks.push(
      expect(
        "按 startedAt 倒序",
        byA.map((r) => r.runId).join(",") === "a4,a3,a2,a1",
        byA.map((r) => r.runId).join(","),
      ),
    );

    const onlyOk = resultStore.listRunsByBlockId("blockA", { status: "ok" });
    checks.push(
      expect(
        "status=ok 过滤掉 err",
        onlyOk.length === 3 && onlyOk.every((r) => r.status === "ok"),
        `got ${onlyOk.length}`,
      ),
    );

    const onlyErr = resultStore.listRunsByBlockId("blockA", { status: "err" });
    checks.push(
      expect(
        "status=err 只剩 1 条",
        onlyErr.length === 1 && onlyErr[0].runId === "a4",
        `got ${onlyErr.length}`,
      ),
    );

    const limited = resultStore.listRunsByBlockId("blockA", { limit: 2 });
    checks.push(
      expect(
        "limit=2 截断最近 2 条",
        limited.map((r) => r.runId).join(",") === "a4,a3",
        limited.map((r) => r.runId).join(","),
      ),
    );

    const paged = resultStore.listRunsByBlockId("blockA", {
      limit: 2,
      offset: 2,
    });
    checks.push(
      expect(
        "offset=2 翻到更早 2 条",
        paged.map((r) => r.runId).join(",") === "a2,a1",
        paged.map((r) => r.runId).join(","),
      ),
    );

    const byB = resultStore.listRunsByBlockId("blockB");
    checks.push(
      expect(
        "blockB 只返回自己的 run",
        byB.length === 1 && byB[0].runId === "b1",
        `got ${byB.length}`,
      ),
    );

    const none = resultStore.listRunsByBlockId("nope");
    checks.push(expect("未知 block 返回空", none.length === 0));
  } finally {
    try {
      resultStore.close();
    } catch {
      /* ignore */
    }
    await rm(vault, { recursive: true, force: true });
  }

  const passed = checks.filter((c) => c.ok).length;
  const failed = checks.length - passed;
  for (const c of checks) {
    console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void main();
