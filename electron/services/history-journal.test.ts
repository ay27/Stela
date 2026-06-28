/**
 * history-journal 单测：JSONL round-trip、游标续读、INSERT OR IGNORE 去重。
 *
 * 聚焦"读合并"侧（import / cursor / dedupe）——这是跨设备同步正确性的关键。
 * 写侧 `appendRunById` 依赖 electron `app`（device slug），不在本单测覆盖范围；
 * 这里直接按稳定的单行格式写 JSONL，验证导入链路。
 *
 * better-sqlite3 是 electron 原生模块，需在 electron runtime 下跑：
 *
 *     ELECTRON_RUN_AS_NODE=1 electron --import tsx electron/services/history-journal.test.ts
 *
 * 已挂在 `npm test`（test:store）。
 */

import {
  mkdtemp,
  rm,
  mkdir,
  readdir,
  appendFile,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as resultStore from "./result-store";
import * as journal from "./history-journal";
import { vaultConfigDir } from "./vault-paths";
import type { ColumnDef, DeviceProfile, RunRecord } from "@shared/types";

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

const checks: Check[] = [];
function expect(name: string, ok: boolean, detail?: string): void {
  checks.push({ name, ok, detail });
}

const COLS: ColumnDef[] = [
  { name: "id", typeName: "INT" },
  { name: "name", typeName: "TEXT" },
];

function makeRecord(
  runId: string,
  startedAt: number,
  rowCount: number,
): RunRecord {
  return {
    runId,
    blockId: "blockA",
    sql: "SELECT 1",
    status: "ok",
    message: null,
    startedAt,
    elapsedMs: 5,
    rowCount,
    connectionName: "test-conn",
    notePath: null,
  };
}

/** 按稳定的单行格式（与 appendRunById 同构）构造一条 JSONL。 */
function journalLine(
  runId: string,
  startedAt: number,
  rows: unknown[][],
): string {
  return JSON.stringify({
    v: 1,
    runId,
    deviceId: "test-device",
    appendedAt: Date.now(),
    record: makeRecord(runId, startedAt, rows.length),
    columns: COLS,
    rows,
  });
}

async function main(): Promise<void> {
  const vault = await mkdtemp(join(tmpdir(), "stela-journal-vault-"));
  const histDir = join(vaultConfigDir(vault), "history");
  const file = join(histDir, "history_test.jsonl");

  try {
    await resultStore.open(vault);
    await mkdir(histDir, { recursive: true });

    // 1) round-trip：写一行 → 增量导入 → 缓存里能查到，且 rows 一致
    const r1Rows: unknown[][] = [
      [1, "alice"],
      [2, "bob"],
    ];
    await appendFile(file, `${journalLine("r1", 1000, r1Rows)}\n`, "utf-8");
    const imp1 = await journal.importIncremental(vault);
    expect("import1: imported 1", imp1.imported === 1, `got ${imp1.imported}`);
    expect("import1: r1 入缓存", resultStore.runExists("r1"));
    expect(
      "import1: rows round-trip 一致",
      JSON.stringify(resultStore.getAllRows("r1")) === JSON.stringify(r1Rows),
      JSON.stringify(resultStore.getAllRows("r1")),
    );
    expect(
      "import1: schema round-trip 一致",
      JSON.stringify(resultStore.getSchema("r1")) === JSON.stringify(COLS),
    );

    // 游标推进到文件末尾
    const sizeAfter1 = (await stat(file)).size;
    expect(
      "cursor: 游标 = 文件大小",
      resultStore.getJournalCursor("history_test.jsonl") === sizeAfter1,
      `${resultStore.getJournalCursor("history_test.jsonl")}/${sizeAfter1}`,
    );

    // 2) 游标续读：无新增时不应重读
    const imp2 = await journal.importIncremental(vault);
    expect(
      "cursor: 二次 linesRead=0",
      imp2.linesRead === 0,
      `got ${imp2.linesRead}`,
    );
    expect("cursor: 二次 imported=0", imp2.imported === 0);

    // 追加新行后，只读到新增的那一行
    await appendFile(
      file,
      `${journalLine("r2", 2000, [[3, "carol"]])}\n`,
      "utf-8",
    );
    const imp3 = await journal.importIncremental(vault);
    expect(
      "cursor: 增量 linesRead=1",
      imp3.linesRead === 1,
      `got ${imp3.linesRead}`,
    );
    expect("cursor: 增量 imported=1", imp3.imported === 1);
    expect("cursor: r2 入缓存", resultStore.runExists("r2"));

    // 3) 半行保护：写入不带换行的半行不应被消费
    await appendFile(file, journalLine("r3", 3000, [[4, "dave"]]), "utf-8");
    const imp4 = await journal.importIncremental(vault);
    expect("partial: 半行不导入", imp4.imported === 0, `got ${imp4.imported}`);
    expect("partial: r3 暂不在缓存", !resultStore.runExists("r3"));
    // 补上换行后才导入
    await appendFile(file, "\n", "utf-8");
    const imp5 = await journal.importIncremental(vault);
    expect("partial: 补换行后导入 r3", resultStore.runExists("r3"));
    expect("partial: imported=1", imp5.imported === 1, `got ${imp5.imported}`);

    // 4) INSERT OR IGNORE 去重 + 全量 rebuild
    // 追加 2 行重复 r1 → 文件现在 r1,r2,r3,r1,r1 共 5 行
    await appendFile(file, `${journalLine("r1", 1000, r1Rows)}\n`, "utf-8");
    await appendFile(file, `${journalLine("r1", 1000, r1Rows)}\n`, "utf-8");
    const rebuilt = await journal.rebuildCache(vault);
    expect(
      "dedupe: rebuild 读到 5 行",
      rebuilt.linesRead === 5,
      `got ${rebuilt.linesRead}`,
    );
    expect(
      "dedupe: 去重后只导入 3 条",
      rebuilt.imported === 3,
      `got ${rebuilt.imported}`,
    );
    expect(
      "dedupe: 缓存里 3 条 run",
      resultStore.listRuns().length === 3,
      `got ${resultStore.listRuns().length}`,
    );

    // 5) importRun 按需：清缓存后只导回目标 runId
    resultStore.clearResultCache();
    expect("importRun: 清缓存后 r2 不在", !resultStore.runExists("r2"));
    const found = await journal.importRun(vault, "r2");
    expect("importRun: 找到并导入 r2", found === true);
    expect("importRun: r2 已入缓存", resultStore.runExists("r2"));
    expect("importRun: 不连带导入 r1", !resultStore.runExists("r1"));
    const missing = await journal.importRun(vault, "nope");
    expect("importRun: 未知 runId 返回 false", missing === false);

    // 5b) 单行截断：append 时整行超过 maxLineBytes → rows=[], message 标 truncated
    journal.__setMaxLineBytesForTest(512);
    try {
      // 造一条 rows JSON > 512B 的 run。每行字符串 ~60B，10 行就够撑过 512B。
      const big: unknown[][] = [];
      for (let i = 0; i < 20; i++) {
        big.push([i, `name-${i}-${"x".repeat(40)}`]);
      }
      const truncRunId = "trunc-1";
      resultStore.saveRun({
        runId: truncRunId,
        blockId: "blockTr",
        sql: "SELECT 1",
        status: "ok",
        message: null,
        startedAt: 8000,
        elapsedMs: 1,
        rowCount: big.length,
        connectionName: "test-conn",
        notePath: null,
      });
      resultStore.saveSchema(truncRunId, COLS);
      resultStore.saveRows(truncRunId, big, 0);
      await journal.appendRunById(vault, truncRunId, {
        deviceId: "test-device",
        slug: "test",
      });
      // 找到刚写出的截断行验证形态
      const { promises: fsp } = await import("node:fs");
      const raw = await fsp.readFile(file, "utf-8");
      const lastLine = raw.trim().split("\n").pop()!;
      const obj = JSON.parse(lastLine) as {
        runId: string;
        rows: unknown[][];
        record: { message: string | null; rowCount: number };
      };
      expect("truncate: runId 写出", obj.runId === truncRunId);
      expect(
        "truncate: rows 被清空",
        obj.rows.length === 0,
        `${obj.rows.length}`,
      );
      expect("truncate: rowCount 保留", obj.record.rowCount === big.length);
      expect(
        "truncate: message 含 truncated 前缀",
        typeof obj.record.message === "string" &&
          obj.record.message.includes("rows truncated"),
        `${obj.record.message}`,
      );
      expect(
        "truncate: 整行 <= 阈值 + 合理 overhead",
        Buffer.byteLength(lastLine, "utf-8") <= 2048,
        `${Buffer.byteLength(lastLine, "utf-8")}`,
      );
    } finally {
      journal.__setMaxLineBytesForTest(null);
    }

    // 6) 文件 rotation：单文件超 maxFileBytes 时封存成段文件、写新活动文件
    //    全清缓存 + 用极小阈值，避免真的写 64MB。
    resultStore.clearResultCache();
    journal.__setMaxFileBytesForTest(512);
    try {
      const rotVault = await mkdtemp(join(tmpdir(), "stela-journal-rot-"));
      try {
        await resultStore.open(rotVault);
        const profile: DeviceProfile = {
          deviceId: "dev-rot",
          slug: "rot",
        };
        const rotDir = join(vaultConfigDir(rotVault), "history");
        // 每条 record 至少 ~120 字节（含 columns/rows + JSON 字段），写 10 条够触发 1 次封存。
        for (let i = 0; i < 10; i++) {
          const rid = `rot-${i}`;
          resultStore.saveRun({
            runId: rid,
            blockId: "blockR",
            sql: "SELECT 1",
            status: "ok",
            message: null,
            startedAt: 10_000 + i,
            elapsedMs: 1,
            rowCount: 1,
            connectionName: "test",
            notePath: null,
          });
          resultStore.saveSchema(rid, COLS);
          // 用 appendRunById 直接走真实写路径（含 rotation）。
          await journal.appendRunById(rotVault, rid, profile);
        }
        const files = (await readdir(rotDir)).filter(
          (f) => f.startsWith("history_rot") && f.endsWith(".jsonl"),
        );
        expect(
          "rotation: 至少产生 1 个段文件",
          files.some((f) => /history_rot\.\d{6}\.jsonl$/.test(f)),
          files.join(","),
        );
        expect("rotation: 活动文件仍存在", files.includes("history_rot.jsonl"));
        // rotate 后 import 应能把所有段 + 活动里的 run 都导入
        resultStore.clearResultCache();
        const imp = await journal.importIncremental(rotVault);
        expect(
          "rotation: 全部 10 条 run 都被增量导入",
          imp.imported === 10,
          `imported=${imp.imported} files=${imp.files}`,
        );
      } finally {
        resultStore.close();
        await rm(rotVault, { recursive: true, force: true });
      }
    } finally {
      journal.__setMaxFileBytesForTest(null);
      // 恢复主测试用的 vault 连接，供后续清理用例继续使用
      await resultStore.open(vault);
    }

    // 7) cleanupOlderThan：按 startedAt 切分，旧行从 JSONL + SQLite 同时清掉
    //    此时 file 在 dedupe 用例后已含 r1,r2,r3,r1,r1 共 5 行（r1 重复 3 次）；
    //    再追加 r4(startedAt=9000) 一行后总共 6 行。
    //    5b) 截断用例还写了 trunc-1（startedAt=8000，> cutoff），不会被清掉。
    resultStore.clearResultCache();
    await journal.importIncremental(vault); // r1/r2/r3/trunc-1 装回缓存
    expect(
      "cleanup: 起始缓存有 4 条（r1/r2/r3 + 截断用例 trunc-1）",
      resultStore.listRuns().length === 4,
      `${resultStore.listRuns().length}`,
    );
    await appendFile(
      file,
      `${journalLine("r4", 9000, [[5, "eve"]])}\n`,
      "utf-8",
    );
    const cs = await journal.cleanupOlderThan(vault, 2500);
    // 早于 2500 的行：r1(1000)+r2(2000)+r1+r1 = 4 行
    expect(
      "cleanup: linesDeleted=4 (含 dedupe 用例残留的 r1 重复)",
      cs.linesDeleted === 4,
      `${cs.linesDeleted}`,
    );
    expect(
      "cleanup: filesRewritten=1",
      cs.filesRewritten === 1,
      `${cs.filesRewritten}`,
    );
    // runsDeleted=2：缓存里 r1/r2 这两条 startedAt<2500 的 run
    expect(
      "cleanup: SQLite 删了 2 条 run",
      cs.runsDeleted === 2,
      `${cs.runsDeleted}`,
    );
    expect(
      "cleanup: r1/r2 已不在 SQLite",
      !resultStore.runExists("r1") && !resultStore.runExists("r2"),
    );
    expect(
      "cleanup: r3 仍在 SQLite（cleanup 不会删 r3）",
      resultStore.runExists("r3"),
    );
    expect(
      "cleanup: r4 此时还未 import，缓存里没有",
      !resultStore.runExists("r4"),
    );
    // 重写后游标已重置：再 import 应把 r4 拿进来（r3 已在 → INSERT OR IGNORE 跳过）
    const post = await journal.importIncremental(vault);
    expect(
      "cleanup: 重写后 import 只新增 r4",
      post.imported === 1,
      `${post.imported}`,
    );
    expect("cleanup: r4 import 后进入 SQLite", resultStore.runExists("r4"));
    expect(
      "cleanup: 文件中已无 r1 行",
      await (async () => {
        const { promises: fsp } = await import("node:fs");
        const buf = await fsp.readFile(file, "utf-8");
        return !buf.includes('"runId":"r1"');
      })(),
    );

    // 8) cleanupByKeepDays(0)：noop
    const noop = await journal.cleanupByKeepDays(vault, 0);
    expect(
      "cleanup: keepDays=0 不动文件",
      noop.linesDeleted === 0 && noop.filesRewritten === 0 && noop.cutoff === 0,
    );
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
    console.log(
      `${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? ` — ${c.detail}` : ""}`,
    );
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void main();
