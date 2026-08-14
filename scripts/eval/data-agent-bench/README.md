# Stela × DataAgentBench

This eval runs Stela's real system prompt, `AgentHarness`, provider transport,
and Agent tools headlessly on the Linux machine that hosts
[DataAgentBench](https://github.com/ucbepic/DataAgentBench). Electron is not
started. The official DAB Python tools load/query the databases and run each
query's validator.

The baseline is intentionally product-faithful:

- Stela keeps `run_sql({ sql })`; no DAB-only `query_db` or `execute_python`
  tool is added.
- Each SQL starts with `-- stela-dab-database: <logical_name>` and may access
  only that logical database. Cross-database work uses separate queries.
- MongoDB remains unsupported by Stela's SQL-only `run_sql` and is reported as
  a capability failure.
- Dataset hints are enabled by default; pass `--no-hints` to disable them.

## Linux runner

The DAB checkout and its services stay on Linux. Install Stela's JavaScript
dependencies without running Electron native rebuild scripts:

```bash
cd /path/to/stela-opensource
npm ci --ignore-scripts

export DAB_ROOT=/jinmianye-cfs-sh-3/jinmianye/data_agent_bench
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
  --resume
```

The default result directory is adjacent to the DAB checkout:
`../dab-results/stela-product-<model>-hints`. Use `--output` to choose an exact
directory. No API key or raw endpoint is written; the manifest records only an
endpoint hash plus both Git commits and tracked-dirty flags.

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

- Runs are sequential because DAB loads and cleans shared PostgreSQL/MongoDB
  datasets.
- Defaults: 100 model responses, 200 tool calls, and 30 minutes per task.
- Stela SQL guard blocks mutations. The bridge uses DAB's official read-only
  query tool and writes traces only to the selected result directory.
- `--resume` reuses only a complete `final_agent.json`; interrupted runs are
  rerun.
