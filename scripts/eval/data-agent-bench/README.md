# Stela × DataAgentBench

## 2026-09-06 执行修复后的对照

主模型启用与桌面一致的生成级恢复：最多三次尝试、共享单次生成 180 秒期限，
不重放已执行工具；取消、敏感内容、鉴权与额度错误不盲重试。
`generation_attempt` 记录有界脱敏诊断，已知失败尝试 usage 计入总量。
批量语义默认全量意图 preflight，预算不足提前返回未处理；不是自动抽样。

Manifest 新增源码 SHA-256 指纹和执行策略版本，无 `.git` 的同步目录也能核对。
`--resume` 拒绝不同源码/策略、模型/端点/推理等级/并发/限制，或缺少指纹的旧目录；
本次请使用**新的 output**。
指纹覆盖源码、共享 Python、playbooks、评测和依赖锁，不读取凭据或结果目录。

小型边界校准入口：

```bash
npm run eval:semantic-boundaries
# 以下命令会使用 STELA_EVAL_* 环境变量发起真实模型请求；不会自动执行。
npm run eval:semantic-boundaries -- --run-model --split dev --reasoning-effort high --output /tmp/stela-semantic-dev-1
npm run eval:semantic-boundaries -- --run-model --split test --reasoning-effort high --output /tmp/stela-semantic-test-1
```

默认仅校验 11 个合成样本，不代表模型准确率；开发/保留集分开，expected 不进入
请求。输出保存模型、推理等级、源码/样本指纹、逐项结果和用量，不冒充 DAB 得分。
先扩充真实业务标注保留集，再判断模型或提示改动收益。
完整 DAB 使用同一源码下的 stateful-only 与 stateful+semantic 配对多次对照；
先覆盖历史语义任务及退步任务，并带原来通过的控制组，最后再跑全量。
不要将失败子集拼接成正式总分，也不要把提前失败带来的耗时下降计为收益。

## 有状态工作区与批量语义对照

默认启用同一 case 内的 Python 工作区；每个 case/trial 独占 Worker 到结束，
超过 `--python-concurrency` 的 case 排队，不会中途驱逐变量。不同 case 不共享状态。
`--stateless-python` 用于无状态消融。

批量文本发送默认关闭。显式加 `--allow-semantic-transmission` 才允许 Python
调用 `semantic.classify/extract/resolve`，相当于本次评测的发送预授权。
`--semantic-model MODEL` 可在同一个已配置 endpoint/API key 下选择独立语义模型；
省略则沿用主 Agent。预算为每个 case/run 共享，而非每次 Python 调用重新计算：

```bash
npm run eval:data-agent-bench -- \
  --dab-root /root/data_agent_bench --all --runs 3 \
  --output /root/dab-results/stela-workspace-semantic \
  --concurrency 3 --mongo-concurrency 2 --python-concurrency 2 \
  --reasoning-effort high --bridge-timeout-ms 600000 \
  --allow-semantic-transmission \
  --semantic-records 1000 --semantic-requests 200 --semantic-tokens 200000
```

分别使用不同 output 运行四组：`--stateless-python`、默认工作区、
`--stateless-python --allow-semantic-transmission`、默认工作区加语义授权。
Manifest 记录模式、模型和预算；`--resume` 不允许混合不同条件。语义子调用的
token 计入总 usage，逐批状态记录在 trace。主模型轮次不包含子模型请求，因此
比较成本必须同时看总 token、semantic request 数和时间。

本地无付费推理验证：`npm run test:semantic`、`npm run test:python-workspace`。
功能测试不能证明准确率提升；真实 DAB 应做配对重复测试并同时报告覆盖率和成本，
失败子集复跑不能替代全量成绩。

This eval runs Stela's real system prompt, `AgentHarness`, provider transport,
and Agent tools headlessly on the Linux machine that hosts
[DataAgentBench](https://github.com/ucbepic/DataAgentBench). Electron is not
started. The official DAB Python tools load/query the databases and run each
query's validator.

The benchmark path is intentionally product-faithful:

- Stela exposes the same structured `run_query` tool used by the desktop app;
  the benchmark adds no DAB-only database tool.
- Each query names exactly one logical database. SQL and MongoDB find inputs use
  DAB's official `QueryDBTool`; safe MongoDB aggregation uses the same dataset
  service directly because upstream has no pipeline input.
- MongoDB aggregation accepts a bounded read-only stage allowlist. Writes,
  cross-collection stages, facets, and JavaScript predicates are rejected.
- Headless Linux exposes the existing `execute_python` tool through isolated
  Node workers running the same offline Pyodide, DuckDB, pandas, execution
  script, sandbox `query()` protocol, artifact authorization, and budgets as the
  desktop. `execute_python.sources` stages known SQL/MongoDB reads under aliases
  available through `tables` / `to_df`; dependent requests can still use
  `await query(connection, request)` and receive a DuckDB relation. SQL sources
  put sampling limits inside the SQL statement; top-level `limit` is MongoDB-only
  and cross-kind fields are rejected before execution. An omitted source `limit`
  means complete, and a source returning exactly its requested row count is
  flagged back to the model as `incompleteSources`.
- Query artifacts retain the complete result and carry it into the sandbox, while
  the model-facing `run_query` preview is bounded to 200 rows / 5 KiB and a
  truncated result is returned as `sampleRows` rather than `rows`.
- Dataset hints are enabled by default; pass `--no-hints` to disable them.
- Product and evaluation runs keep a bounded in-memory analysis ledger. Repeated
  query families receive a deterministic hint, and a stalled run gets at most
  one tool-free strategy review from the current Agent model.
- There is no semantic review of a candidate answer. ADR-0078 removed the
  planned-result reviewer and the plan finalization gate it depended on; a plan
  is progress bookkeeping and never gates an answer. Older result directories
  may still carry a `resultReview` field, which the report reads for history
  only.

## Linux runner

The DAB checkout and its services stay on Linux. Install Stela's JavaScript
dependencies without running Electron native rebuild scripts:

```bash
cd /path/to/stela-opensource
npm ci --ignore-scripts
npm run prepare:pyodide

# Keep large SQLite/DuckDB files on a local disk. NFS can turn one scan into hours.
export DAB_ROOT=/root/data_agent_bench
export STELA_EVAL_API_KEY=...
export STELA_EVAL_BASE_URL=...
export STELA_EVAL_MODEL=deepseek-v4-flash
# Optional; defaults to medium. CLI --reasoning-effort takes precedence.
export STELA_EVAL_REASONING_EFFORT=medium

npm run test:eval:data-agent-bench
npm run eval:data-agent-bench -- --dab-root "$DAB_ROOT" --self-check

npm run eval:data-agent-bench -- \
  --dab-root "$DAB_ROOT" \
  --dataset bookreview \
  --query-id 1 \
  --runs 1

npm run eval:data-agent-bench -- \
  --dab-root "$DAB_ROOT" \
  --all \
  --concurrency 3 \
  --mongo-concurrency 2 \
  --python-concurrency 2 \
  --reasoning-effort medium \
  --bridge-timeout-ms 600000 \
  --resume
```

To rerun only the cases that were invalid in a previous completed result directory,
keep the new output separate and select them with `--failed-from`:

```bash
npm run eval:data-agent-bench -- \
  --dab-root "$DAB_ROOT" \
  --failed-from /path/to/previous-results \
  --output /path/to/failed-rerun \
  --runs 1 \
  --concurrency 3 \
  --mongo-concurrency 2 \
  --python-concurrency 2 \
  --reasoning-effort high \
  --bridge-timeout-ms 600000 \
  --resume
```

Selection reads ordered `query_<dataset>/queryN/run_M/final_agent.json` files and
includes each distinct case with at least one completed `valid=false` run. It does
not select cases merely because an intermediate routing or tool error occurred.
`--failed-from` is mutually exclusive with `--all`, `--dataset`, `--query-id`, and
`--self-check`; the manifest records the source directory and exact selected cases.

MongoDB queries are read-only, but DAB's upstream `QueryDBTool` normally owns a
destructive fixture lifecycle: it drops an existing physical database, restores
the dump, and drops the database again on cleanup. Stela therefore keeps fixture
isolation while allowing safe read concurrency:

- `--mongo-concurrency` defaults to `min(2, --concurrency)` and limits active
  Mongo cases independently of the global worker count.
- `--mongo-fixture-mode shared` is the default. One owner bridge loads each
  selected Mongo dataset once; child case bridges query it read-only and never
  clean it up. Cases from the same dataset may run concurrently.
- `--mongo-fixture-mode per-run` restores the conservative lifecycle. Different
  physical Mongo databases may run concurrently, while cases sharing a physical
  fixture remain serial. Combine it with `--mongo-concurrency 1` to reproduce
  the old globally serial behavior.
- The runner rejects ambiguous physical database collisions before starting a
  shared run. Configs it cannot classify fall back to a conservative fixture
  lock rather than running unsafely.

The manifest records the effective Mongo settings and detected fixture locks.
`scheduler.jsonl` records job concurrency plus fixture prepare/cleanup timings,
so throughput changes and lock contention can be audited after the run.

If `mongorestore` is supplied by a Docker wrapper and `DAB_ROOT` is below
`/root`, make sure the wrapper does not let the Mongo image entrypoint drop
privileges before reading the bind mount. The verified invocation uses
`docker run --user 0:0 --entrypoint mongorestore ...`.

The default result directory is adjacent to the DAB checkout:
`../dab-results/stela-product-<model>-hints`. Use `--output` to choose an exact
directory. No API key or raw endpoint is written; the manifest records only an
endpoint hash plus both Git commits and tracked-dirty flags.

Pyodide is required by default. Use `--pyodide-assets /path/to/assets` to point
at a prepared offline closure. `--no-python` exists only to reproduce the older
headless baseline and is recorded in the manifest.

Reasoning effort defaults to `medium`. `--reasoning-effort` overrides
`STELA_EVAL_REASONING_EFFORT`; both accept
`off|minimal|low|medium|high|xhigh|max`. Custom eval endpoints are treated as
supporting the selected standard `reasoning_effort`, and rejection is a run
error rather than a silent retry. Requested and effective values are written to
the manifest, each `final_agent.json`, the summary, and generated report.

Strategy review is enabled by default and recorded in the manifest and each
`final_agent.json`. Pass `--no-strategy-review` to build a same-commit A/B
baseline. The reviewer has no tools, never blocks the main Agent, uses the
active eval model, and its tokens are included in total usage.

`--salvage-ms` (default 120000) is held back from `--timeout-ms`, not added to
it. When a run hits the wall clock or a tool cap with no answer text, the runner
takes the tools away and spends that slice on one final turn over the evidence
already gathered, so a capped case is scored on its best available answer rather
than on the empty string. Salvaged cases carry a `*_salvaged` `terminateReason`
and log `salvage_start` / `salvage_end` in `tool_calls.jsonl`. Pass
`--salvage-ms 0` to restore the old hard stop.

Generate the static analysis dashboard from any completed result directory:

```bash
npm run report:data-agent-bench -- --input /path/to/completed-results
python3 -m http.server 8765 --directory /path/to/completed-results/analysis
```

Then open `http://127.0.0.1:8765`. The generated analysis JSON truncates large
tool payloads while the original `final_agent.json` files remain untouched.

For ongoing evaluations, keep every completed run in a separate directory and
build one historical dashboard from their common parent:

```bash
npm run report:data-agent-bench -- \
  --history-root /path/to/dab-results \
  --output /path/to/dab-results/analysis
python3 -m http.server 8765 --directory /path/to/dab-results/analysis
```

History mode discovers completed child directories, writes a small
`history.json` index, and stores each run's truncated analysis separately below
`analysis/runs/`. The browser loads only the selected current and comparison
runs. Tool cards separately show actual successful calls, deterministic/domain
rejections, runtime failures, grouped causes, and calls observed inside
validator-passing versus validator-failing cases. The latter is correlation,
not tool success. Cards also show calls per case and the delta from the selected
comparison, so prompt changes can be checked for unnecessary planning or
retrieval calls.

Rejection versus runtime failure is decided on the error head only. An
`execute_python` failure appends `stdout:` and guidance after the real error,
and any run with staged sources opens its stdout with an
`[INPUTS] tables[alias] … pandas DataFrame` banner, so classifying on the whole
payload reads every genuine Python exception as a contract rejection. A harness
refusal is identified by its `nothing was executed` suffix. Comparing this
split across runs that differ in staged-source adoption is only meaningful with
this rule in place.

Failure attribution distinguishes a transient database-routing mistake from an
unrecovered blocker. An `unknown_database`, `missing_database_route`, or
`query_language_mismatch` result is marked `recovered` when a later
`run_query`, legacy `run_sql`, or `execute_python` call succeeds. Recovered
mistakes remain visible as trajectory and efficiency signals but do not replace
the validator's final `wrong_answer`/`validation_failure` attribution. Only a
routing error with no later successful data call becomes the primary
`routing_error` or `query_language_mismatch` category. Legacy runs that retain
only aggregate capability counts, without an ordered matching tool result, are
reported as `indeterminate` when another data call succeeded.

Re-run the same command after copying in a new result directory; existing history
remains available by directory identity and completion timestamp.

To keep expert interpretation beside the raw numbers, add an optional
`analysis-notes.json` to each result directory before generating the report. The
history dashboard loads that narrative with the selected run, so conclusions do
not get detached from the exact model, coverage, and artifacts that produced
them. The file uses this versioned shape:

```json
{
  "schemaVersion": 1,
  "status": "complete",
  "title": "What this run established",
  "summary": "One concise conclusion.",
  "headlineMetrics": [
    { "label": "Strict score", "value": "68 / 104", "note": "65.4%" }
  ],
  "findings": [
    {
      "title": "A finding",
      "evidence": ["A trace-grounded observation."],
      "interpretation": "What the evidence does and does not establish."
    }
  ],
  "comparability": ["Same model and run count as the baseline."],
  "limitations": ["Known coverage or instrumentation gaps."],
  "nextSteps": ["The next bounded experiment."]
}
```

Use `status: "partial"` for interrupted runs and `status: "historical"` when the
analysis was reconstructed after the fact. Malformed notes fail report
generation instead of being silently omitted.

`--runs` defaults to 3 and reports a **valid rate**, not leaderboard Pass@1. A
single run per case leaves roughly a five-point binomial standard error, which is
larger than the differences prompt and gate changes usually produce, so `--runs 1`
is for smoke checks only. For a leaderboard-shaped result use `--all --runs 5`;
`submission.json` uses DAB's `dataset/query/run/answer` shape.

Never read a change's effect off two unpaired valid rates. Compare two result
directories on the cases both completed, majority-voting repeated runs, with
McNemar's exact test:

```bash
npx tsx scripts/eval/compare-data-agent-bench.ts \
  --baseline /path/to/previous-results \
  --candidate /path/to/new-results
```

DAB's own `validate.py` is the authority for correctness and is intentionally not
modified here, so leaderboard comparability is preserved. It matches ground truth
loosely: an answer that names the right entity while concluding the wrong one can
still be marked valid. Treat per-case verdicts as noisy and decide on the paired
statistic, not on individual cases.

Deciding whether an Agent change earns its place therefore takes two commands on
the Linux eval host, with the same model, reasoning effort, and concurrency in
both:

```bash
# 1. Candidate, semantic review off (the default product path).
npm run eval:data-agent-bench -- \
  --dab-root "$DAB_ROOT" --all --reasoning-effort high \
  --concurrency 3 --python-concurrency 2 --bridge-timeout-ms 600000 --resume \
  --output /path/to/dab-results/candidate

# 2. Paired verdict against the previous accepted run.
npm run compare:data-agent-bench -- \
  --baseline /path/to/dab-results/previous-accepted \
  --candidate /path/to/dab-results/candidate
```

A candidate that does not win the paired test does not earn its place, however
plausible the mechanism. Report elapsed time and token cost next to any accuracy
delta.

## Optional Mac desktop parity smoke through SSH

The scored run stays on Linux. To check that the actual Mac Agent Panel behaves
the same, install the SSH shim as a subprocess connector in a temporary Vault.
The shim emits Stela's connector handshake locally, then holds one SSH tunnel
to the Linux bridge; databases never leave Linux.

Use `/usr/bin/env` as the plugin executable and arguments equivalent to:

```bash
node /absolute/path/to/stela/scripts/eval/data-agent-bench/ssh-connector.mjs \
  --host root@9.134.85.45 \
  --port 36000 \
  --remote-bridge /absolute/linux/path/to/stela/scripts/eval/data-agent-bench/bridge.py \
  --dab-root /jinmianye-cfs-sh-3/jinmianye/data_agent_bench \
  --conda-env dabench
```

Create a `dab-remote` connection with `dataset: stockindex`, `queryId: 1`, and
a remote temporary `runDir`. Paste the same description, hints, connection
contract, and query used by the headless run. Validate the final text on Linux;
this smoke is a parity check and is not included in benchmark scores.

## Safety and limits

- Runs within one dataset remain sequential because DAB loads and cleans shared
  database state. `--concurrency N` runs different datasets in parallel, while
  datasets backed by the shared MongoDB service are mutually exclusive. Keep
  concurrency bounded by database capacity and provider rate limits.
- Defaults: one dataset worker, 100 model responses, 200 tool calls, 10 minutes
  per bridge call, and 30 minutes per task. Task timeout also terminates the
  bridge process group so a blocking SQL call cannot outlive the run.
- Stela's SQL guard blocks mutations. MongoDB accepts only structured read-only
  find or allowlisted aggregation, with TypeScript and Python validation. The
  bridge uses DAB's official query tool except for aggregation, which upstream
  cannot express.
- `--python-concurrency` defaults to 2 independently isolated runtimes; lower it
  to 1 on memory-constrained hosts.
- `--resume` reuses only a complete `final_agent.json` with matching requested
  and effective reasoning effort; interrupted or incompatible runs are rerun.
  Legacy results without effort metadata are treated as `off`.
