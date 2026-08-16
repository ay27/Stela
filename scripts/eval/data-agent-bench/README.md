# Stela × DataAgentBench

This eval runs Stela's real system prompt, `AgentHarness`, provider transport,
and Agent tools headlessly on the Linux machine that hosts
[DataAgentBench](https://github.com/ucbepic/DataAgentBench). Electron is not
started. The official DAB Python tools load/query the databases and run each
query's validator.

The benchmark path is intentionally product-faithful:

- Stela exposes the same structured `run_query` tool used by the desktop app;
  the benchmark adds no DAB-only database tool.
- Each query names exactly one logical database. SQL and MongoDB inputs are
  dispatched through DAB's official `QueryDBTool`; cross-database work uses
  separate queries and the normal Stela result artifacts.
- MongoDB is a bounded, read-only `find` request with structured filter,
  projection, and limit fields. JavaScript predicates such as `$where` are
  rejected.
- Headless Linux runs do not expose `execute_python`, because its Pyodide
  security boundary is a desktop runtime capability. Cross-database Python
  analysis therefore requires a separate Mac desktop smoke test.
- Dataset hints are enabled by default; pass `--no-hints` to disable them.

## Linux runner

The DAB checkout and its services stay on Linux. Install Stela's JavaScript
dependencies without running Electron native rebuild scripts:

```bash
cd /path/to/stela-opensource
npm ci --ignore-scripts

# Keep large SQLite/DuckDB files on a local disk. NFS can turn one scan into hours.
export DAB_ROOT=/root/data_agent_bench
export STELA_EVAL_API_KEY=...
export STELA_EVAL_BASE_URL=...
export STELA_EVAL_MODEL=deepseek-v4-flash

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

Generate the static analysis dashboard from any completed result directory:

```bash
npm run report:data-agent-bench -- --input /path/to/completed-results
python3 -m http.server 8765 --directory /path/to/completed-results/analysis
```

Then open `http://127.0.0.1:8765`. The generated analysis JSON truncates large
tool payloads while the original `final_agent.json` files remain untouched.

One internal run per query reports a **valid rate**, not leaderboard Pass@1.
For a leaderboard-shaped result, run `--all --runs 5`; `submission.json` uses
DAB's `dataset/query/run/answer` shape.

## Mac desktop smoke through SSH

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
- Stela's SQL guard blocks mutations, and MongoDB accepts only structured
  read-only finds. The bridge uses DAB's official query tool and writes traces
  only to the selected result directory.
- `--resume` reuses only a complete `final_agent.json`; interrupted runs are
  rerun.
