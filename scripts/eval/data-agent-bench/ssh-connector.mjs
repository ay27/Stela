#!/usr/bin/env node

import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

export const CONNECTOR_META = {
  kind: "dab-remote",
  displayName: "DataAgentBench Remote",
  subprocess: true,
  dialect: "DAB routed SQL",
  configSchema: {
    type: "object",
    properties: {
      dataset: { type: "string", title: "DAB dataset" },
      queryId: { type: "number", title: "Query id" },
      runDir: { type: "string", title: "Remote run directory" },
    },
    required: ["dataset"],
  },
  defaultConfig: {
    dataset: "stockindex",
    queryId: 1,
    runDir: "/tmp/stela-dab-mac-smoke",
  },
};

function argValue(argv, name, fallback = undefined) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
}

export function parseSshConnectorArgs(argv) {
  const host = argValue(argv, "--host");
  const remoteBridge = argValue(argv, "--remote-bridge");
  const dabRoot = argValue(argv, "--dab-root");
  if (!host || !remoteBridge || !dabRoot) {
    throw new Error("--host, --remote-bridge, and --dab-root are required");
  }
  return {
    host,
    port: argValue(argv, "--port", "22"),
    identity: argValue(argv, "--identity"),
    remoteBridge,
    dabRoot,
    condaEnv: argValue(argv, "--conda-env", "dabench"),
  };
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

export function buildRemoteCommand(options) {
  return [
    "conda",
    "run",
    "-n",
    shellQuote(options.condaEnv),
    "python",
    "-u",
    shellQuote(options.remoteBridge),
    "--dab-root",
    shellQuote(options.dabRoot),
  ].join(" ");
}

export function buildSshArgs(options) {
  const args = [
    "-p",
    String(options.port),
    "-o",
    "BatchMode=yes",
    "-o",
    "ServerAliveInterval=30",
    "-o",
    "ServerAliveCountMax=3",
  ];
  if (options.identity) args.push("-i", options.identity);
  args.push(options.host, buildRemoteCommand(options));
  return args;
}

export function run(argv = process.argv.slice(2)) {
  const options = parseSshConnectorArgs(argv);
  // Stela waits only five seconds for hello. Emit local metadata before SSH and
  // conda startup; subsequent connector calls wait on the persistent tunnel.
  process.stdout.write(`${JSON.stringify({ method: "hello", result: CONNECTOR_META })}\n`);

  const child = spawn("ssh", buildSshArgs(options), { stdio: ["pipe", "pipe", "pipe"] });
  process.stdin.pipe(child.stdin);
  child.stdout.pipe(process.stdout);
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  child.on("error", (error) => {
    process.stderr.write(`DAB SSH connector failed: ${error.message}\n`);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    if (signal) process.stderr.write(`DAB SSH connector stopped by ${signal}\n`);
    process.exitCode = code ?? 1;
  });
  const stop = () => {
    if (!child.killed) child.kill("SIGTERM");
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.once("exit", stop);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    run();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
