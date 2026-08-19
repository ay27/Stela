# Stela × DataAgentBench

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
  script, artifact authorization, timeout, and result limits as the desktop.
- Dataset hints are enabled by default; pass `--no-hints` to disable them.
- Product and evaluation runs keep a bounded in-memory analysis ledger. Repeated
  query families receive a deterministic hint, and a stalled run gets at most
  one tool-free strategy review from the current Agent model.

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
  --runs 1 \
  --concurrency 3 \
  --python-concurrency 2 \
  --reasoning-effort medium \
  --bridge-timeout-ms 600000 \
  --resume
```

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
runs. Tool cards show calls per case and the delta from the selected comparison,
so prompt changes can be checked for unnecessary planning or retrieval calls.
Re-run the same command after copying in a new result directory; existing history
remains available by directory identity and completion timestamp.

One internal run per query reports a **valid rate**, not leaderboard Pass@1.
For a leaderboard-shaped result, run `--all --runs 5`; `submission.json` uses
DAB's `dataset/query/run/answer` shape.

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
