/**
 * RRF 融合行为自测。
 *
 * 覆盖：
 *   - 单路命中：score = 1 / (k + rank+1)
 *   - 双路命中同 id：分数累加，排在前面
 *   - topK 截断
 *   - 输入为空时返回空数组
 *
 * 运行：
 *
 *     npx tsx electron/services/knowledge/retriever.test.ts
 */

import { rrfFuse } from "./retriever";

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

const checks: Check[] = [];

function expect(name: string, ok: boolean, detail?: string): Check {
  return { name, ok, detail };
}

// 1. 单路命中
{
  const fused = rrfFuse(
    [
      { chunkId: "a", distance: 0.1 },
      { chunkId: "b", distance: 0.2 },
    ],
    [],
    10,
  );
  checks.push(expect("single route order preserved", fused.map((f) => f.chunkId).join(",") === "a,b"));
  const expectedA = 1 / (60 + 1);
  checks.push(
    expect(
      "single route score = 1/(k+rank+1)",
      Math.abs(fused[0]!.score - expectedA) < 1e-9,
      `got=${fused[0]!.score} want=${expectedA}`,
    ),
  );
}

// 2. 双路同 id 累加
{
  const fused = rrfFuse(
    [{ chunkId: "x", distance: 0.1 }],
    [{ chunkId: "x", bm25: -1.0 }],
    10,
  );
  const want = 1 / 61 + 1 / 61;
  checks.push(
    expect(
      "dual-hit score sums",
      fused.length === 1 && Math.abs(fused[0]!.score - want) < 1e-9,
      JSON.stringify(fused),
    ),
  );
}

// 3. 双路异 id 排序
{
  const fused = rrfFuse(
    [
      { chunkId: "a", distance: 0.1 },
      { chunkId: "b", distance: 0.2 },
    ],
    [
      { chunkId: "b", bm25: -1.0 },
      { chunkId: "c", bm25: -1.5 },
    ],
    10,
  );
  // b 同时出现在两路，分数最高
  checks.push(
    expect(
      "shared id ranks first",
      fused[0]!.chunkId === "b",
      fused.map((f) => f.chunkId).join(","),
    ),
  );
}

// 4. topK 截断
{
  const dense = Array.from({ length: 30 }, (_, i) => ({
    chunkId: `d${i}`,
    distance: i * 0.01,
  }));
  const fused = rrfFuse(dense, [], 5);
  checks.push(expect("topK truncated", fused.length === 5, `len=${fused.length}`));
}

// 5. 空输入
{
  const fused = rrfFuse([], [], 10);
  checks.push(expect("empty input → empty output", fused.length === 0));
}

let pass = 0;
let fail = 0;
for (const c of checks) {
  if (c.ok) {
    pass += 1;
    console.log(`PASS  ${c.name}`);
  } else {
    fail += 1;
    console.log(`FAIL  ${c.name}  ${c.detail ?? ""}`);
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
