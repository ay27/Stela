/**
 * 种子化合成 fixture vault。可提交、可进 CI、不含任何真实业务数据。
 *
 * 刻意复刻真实 vault 的三个结构特征，否则评测测不到真问题：
 *   1. schemaDir 里的表数量**超过** `MAX_SCHEMA_FILES`，暴露按 readdir 顺序的截断；
 *   2. 表名是 ascii slug，业务语义只存在于列的中文 `COMMENT "..."` 里
 *      （StarRocks 风格双引号），所以中文查询必须靠 comment 才能命中；
 *   3. 大量只有散文、没有 runsql 的噪声笔记，构成排名竞争。
 *
 * gold 不需要单独维护：生成器种下的事实由 `corpus.ts` 的机械派生原样恢复，
 * 两边同源，所以「gold 按构造产出」这一点是成立的。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const FIXTURE_NAME = "stela-eval-fixture-v1";

const SCHEMA_TABLE_COUNT = 620;
const ANALYSIS_NOTE_COUNT = 220;
const NOISE_NOTE_COUNT = 380;
/** 前 N 张表被刻意反复引用，制造「一张表散落在几十篇笔记」的排名竞争。 */
const HOT_TABLE_COUNT = 8;

/** 中文业务域：域名只出现在 heading 与列 COMMENT 里，绝不出现在表名里。 */
const DOMAINS = [
  { zh: "订单处理", slug: "order_process" },
  { zh: "库存同步", slug: "inventory_sync" },
  { zh: "报表生成", slug: "report_generate" },
  { zh: "用户导入", slug: "user_import" },
  { zh: "权限校验", slug: "permission_check" },
  { zh: "通知发送", slug: "notification_send" },
  { zh: "数据归档", slug: "data_archive" },
  { zh: "文件索引", slug: "file_index" },
  { zh: "配置发布", slug: "config_publish" },
  { zh: "任务调度", slug: "job_schedule" },
  { zh: "日志聚合", slug: "log_aggregate" },
  { zh: "缓存刷新", slug: "cache_refresh" },
];

const METRICS = [
  { zh: "完成率", slug: "completion_rate", column: "completed_flag" },
  { zh: "处理耗时", slug: "processing_time", column: "processing_ms" },
  { zh: "异常类型", slug: "error_type", column: "error_code" },
  { zh: "处理数量", slug: "processed_count", column: "processed_num" },
];

const DATABASES = ["dsA", "dsB", "dsC"];

/** mulberry32：小、确定性、无依赖。 */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface FixtureTable {
  database: string;
  table: string;
  domain: (typeof DOMAINS)[number];
  metric: (typeof METRICS)[number];
}

function buildTables(): FixtureTable[] {
  const out: FixtureTable[] = [];
  for (let i = 0; i < SCHEMA_TABLE_COUNT; i++) {
    const domain = DOMAINS[i % DOMAINS.length]!;
    const metric = METRICS[i % METRICS.length]!;
    out.push({
      database: DATABASES[i % DATABASES.length]!,
      table: `${domain.slug}_${metric.slug}_${String(i).padStart(4, "0")}`,
      domain,
      metric,
    });
  }
  return out;
}

function ddlFor(entry: FixtureTable): string {
  return `# ${entry.database}.${entry.table}

连接: SR

\`\`\`sql
CREATE TABLE \`${entry.database}\`.\`${entry.table}\` (
  \`id\` bigint NOT NULL COMMENT "主键",
  \`task_id\` varchar(64) NULL COMMENT "${entry.domain.zh}任务标识",
  \`${entry.metric.column}\` int NULL COMMENT "${entry.domain.zh}${entry.metric.zh}",
  \`stage_name\` varchar(64) NULL COMMENT "${entry.domain.zh}所处阶段",
  \`created_at\` datetime NULL COMMENT "记录创建时间"
) ENGINE=OLAP
DUPLICATE KEY(\`id\`)
DISTRIBUTED BY HASH(\`id\`) BUCKETS 8;
\`\`\`
`;
}

function analysisNote(entry: FixtureTable, extra: FixtureTable, index: number): string {
  const qualified = `${entry.database}.${entry.table}`;
  return `# 分析记录 ${index}

## ${entry.domain.zh}${entry.metric.zh}统计

统计本周期内的${entry.domain.zh}情况。

\`\`\`runsql
SELECT stage_name, count(*) AS n
FROM ${qualified}
WHERE ${entry.metric.column} IS NOT NULL
GROUP BY stage_name
\`\`\`

## ${extra.domain.zh}对照

\`\`\`runsql
SELECT a.task_id
FROM ${qualified} AS a
JOIN ${extra.database}.${extra.table} AS b ON a.task_id = b.task_id
\`\`\`
`;
}

function noiseNote(domain: (typeof DOMAINS)[number], metric: (typeof METRICS)[number], index: number): string {
  return `# 会议记录 ${index}

## ${domain.zh}讨论

本次讨论涉及${domain.zh}的${metric.zh}问题，暂无结论，后续补充。相关同学负责跟进
${domain.zh}的流程梳理，并在下个迭代给出${metric.zh}的口径定义。
`;
}

/**
 * 生成到 tmpdir 下的固定路径。每次重建（600 多个小文件，几十毫秒），
 * 避免残留状态让评测结果不可复现。
 */
export async function materializeFixture(): Promise<string> {
  const root = path.join(os.tmpdir(), FIXTURE_NAME);
  await fs.rm(root, { recursive: true, force: true });

  const schemaDir = path.join(root, "schema");
  const notesDir = path.join(root, "notes");
  const noiseDir = path.join(root, "notes-noise");
  await fs.mkdir(schemaDir, { recursive: true });
  await fs.mkdir(notesDir, { recursive: true });
  await fs.mkdir(noiseDir, { recursive: true });
  await fs.mkdir(path.join(root, ".stela"), { recursive: true });

  const tables = buildTables();
  await Promise.all(
    tables.map((entry) =>
      fs.writeFile(
        path.join(schemaDir, `${entry.database}.${entry.table}.md`),
        ddlFor(entry),
        "utf-8",
      ),
    ),
  );

  const rng = makeRng(0x51e1a);
  // 一半的笔记集中查 HOT_TABLE_COUNT 张「热表」，制造真实 vault 里那种
  // 「同一张表出现在几十篇笔记」的高竞争场景——否则测不到任意截断。
  const pickTable = (): FixtureTable =>
    rng() < 0.5
      ? tables[Math.floor(rng() * HOT_TABLE_COUNT)]!
      : tables[Math.floor(rng() * tables.length)]!;
  await Promise.all(
    Array.from({ length: ANALYSIS_NOTE_COUNT }, (_, i) => {
      const entry = pickTable();
      const extra = pickTable();
      return fs.writeFile(
        path.join(notesDir, `analysis-${String(i).padStart(3, "0")}.md`),
        analysisNote(entry, extra, i),
        "utf-8",
      );
    }),
  );

  await Promise.all(
    Array.from({ length: NOISE_NOTE_COUNT }, (_, i) => {
      const domain = DOMAINS[Math.floor(rng() * DOMAINS.length)]!;
      const metric = METRICS[Math.floor(rng() * METRICS.length)]!;
      return fs.writeFile(
        path.join(noiseDir, `meeting-${String(i).padStart(3, "0")}.md`),
        noiseNote(domain, metric, i),
        "utf-8",
      );
    }),
  );

  await fs.writeFile(
    path.join(root, ".stela", "connections.json"),
    `${JSON.stringify(
      {
        entries: {
          SR: {
            kind: "http",
            config: { endpoint: "http://127.0.0.1/unused", method: "POST" },
            schemaDir,
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );

  return root;
}
