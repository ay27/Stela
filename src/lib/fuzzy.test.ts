/**
 * fuzzy.ts 单测。
 *
 *     npx tsx src/lib/fuzzy.test.ts
 */
import { fuzzyFilter, fuzzyMatch } from "./fuzzy";

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

const results: Check[] = [];
function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail });
}

check(
  "非连续子序列也能命中",
  fuzzyMatch("shapegenfull", "threed_datasets.shapegen_part_full_dataset") !== null,
);

check("大小写不敏感", fuzzyMatch("SHAPEGEN", "shapegen_part_full_dataset") !== null);

check("完全无关字符串不命中", fuzzyMatch("xyz123", "shapegen_part_full_dataset") === null);

check("空 query 命中一切", fuzzyMatch("", "anything") !== null);

{
  const items = ["shapegen_part_full_dataset", "shapegen_part_eval_dataset", "orders"];
  const filtered = fuzzyFilter("shapegenfull", items, (s) => s);
  check(
    "fuzzyFilter 按匹配紧凑度排序，最佳匹配在前",
    filtered[0] === "shapegen_part_full_dataset",
    JSON.stringify(filtered),
  );
}

{
  const items = ["orders", "order_items"];
  const filtered = fuzzyFilter("nomatch", items, (s) => s);
  check("fuzzyFilter 无命中返回空数组", filtered.length === 0, JSON.stringify(filtered));
}

let failed = 0;
for (const r of results) {
  if (r.ok) {
    console.log(`  ok  ${r.name}`);
  } else {
    failed += 1;
    console.log(`  !!! ${r.name}${r.detail ? `   -> ${r.detail}` : ""}`);
  }
}
console.log(`\nfuzzy.test.ts: ${results.length - failed}/${results.length} passed`);
if (failed > 0) process.exit(1);
