/**
 * MCP server lifecycle —— main 进程侧。
 *
 * 设计：MCP server 真正给外部 LLM 用时，是 Claude Desktop / Cursor 自己 spawn 我们打包出的
 * `out/mcp/server.cjs` child。我们在 Stela main 进程里维护的"start/stop"用来：
 *   1. dogfood：start 时主进程 fork 一个 child，做 stdio 自检（write list_tools，期望 200ms 内返回）
 *   2. 给 Settings UI 提供"是否健康"的红绿灯，UI 显示 status + 最近日志（child stderr）
 *   3. backoff：连续启动失败时记录，让用户看到
 *
 * 这种方案不强求 child 一直常驻——常驻进程会与 Claude Desktop 自己 spawn 的 child 重复，
 * 浪费 CPU。我们的 child 只在 health-check / 启动一刻打开，输出 `__stela_mcp_ready` 后就被 kill。
 *
 * mcp config snippet：返回一段 JSON，含 child 入口的绝对路径 + STELA_VAULT_PATH env。用户复制粘贴。
 */

import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

import { AppError } from "@shared/errors";
import type { McpStatus, McpConfigSnippet, McpServerState } from "@shared/types";

import { getLogger } from "../logger";
import { listToolNames } from "./tools";

const log = getLogger("mcp-server");

const READY_MARKER = "__stela_mcp_ready";
const READY_TIMEOUT_MS = 5_000;
const MAX_LOG_LINES = 1_000;
const BACKOFF_WINDOW_MS = 60_000;
const MAX_FAILS_IN_WINDOW = 3;

interface Runtime {
  vaultPath: string;
  state: McpServerState;
  enabled: boolean;
  child: ChildProcess | null;
  pid: number | null;
  startedAt: number | null;
  lastError: string | null;
  toolCount: number;
  /** 失败时间戳列表，仅保留最近 BACKOFF_WINDOW_MS 内 */
  recentFailures: number[];
  logBuffer: string[];
}

let runtime: Runtime | null = null;

export function configure(vaultPath: string | null): void {
  if (!vaultPath) {
    if (runtime) {
      void stop().catch(() => {});
    }
    runtime = null;
    return;
  }
  if (runtime && runtime.vaultPath === vaultPath) return;
  if (runtime) {
    void stop().catch(() => {});
  }
  runtime = {
    vaultPath,
    state: "stopped",
    enabled: false,
    child: null,
    pid: null,
    startedAt: null,
    lastError: null,
    toolCount: listToolNames().length,
    recentFailures: [],
    logBuffer: [],
  };
}

export function status(): McpStatus {
  if (!runtime) {
    return {
      state: "stopped",
      enabled: false,
      pid: null,
      uptimeMs: null,
      lastError: null,
      toolCount: listToolNames().length,
    };
  }
  return {
    state: runtime.state,
    enabled: runtime.enabled,
    pid: runtime.pid,
    uptimeMs: runtime.startedAt ? Date.now() - runtime.startedAt : null,
    lastError: runtime.lastError,
    toolCount: runtime.toolCount,
  };
}

export function logs(limit?: number): string[] {
  if (!runtime) return [];
  const max = Math.max(1, Math.min(limit ?? MAX_LOG_LINES, MAX_LOG_LINES));
  if (runtime.logBuffer.length <= max) return [...runtime.logBuffer];
  return runtime.logBuffer.slice(runtime.logBuffer.length - max);
}

export function clearLogs(): void {
  if (!runtime) return;
  runtime.logBuffer = [];
}

/**
 * Health-check 启动：spawn child → 等 ready marker → 接收 state="running"。
 * 若 child 在 READY_TIMEOUT_MS 内未发 marker → kill + state="errored"。
 *
 * **不**保留 child 长时间运行；外部 LLM 会自己 spawn 自己的 child。
 * 但保留 `child` 引用以便 Stop 按钮真的 kill 一个长期跑的 dogfood instance。
 */
export async function start(): Promise<void> {
  if (!runtime) {
    throw new AppError("no_vault", "no vault opened; cannot start MCP server");
  }
  if (runtime.state === "running" || runtime.state === "starting") return;
  runtime.enabled = true;
  // 在 backoff window 内失败过太多次 → 直接拒绝，避免无限循环
  const now = Date.now();
  runtime.recentFailures = runtime.recentFailures.filter(
    (t) => now - t < BACKOFF_WINDOW_MS,
  );
  if (runtime.recentFailures.length >= MAX_FAILS_IN_WINDOW) {
    runtime.state = "errored";
    runtime.lastError = `too many failures in last minute (${runtime.recentFailures.length}/${MAX_FAILS_IN_WINDOW})`;
    throw new AppError("mcp_start_failed", runtime.lastError);
  }
  runtime.state = "starting";
  runtime.lastError = null;

  const { command, args, env } = resolveServerSpawn(runtime.vaultPath);
  let child: ChildProcess;
  try {
    child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
  } catch (err) {
    runtime.state = "errored";
    runtime.lastError = err instanceof Error ? err.message : String(err);
    runtime.recentFailures.push(Date.now());
    throw new AppError("mcp_start_failed", runtime.lastError);
  }
  runtime.child = child;
  runtime.pid = typeof child.pid === "number" ? child.pid : null;
  runtime.startedAt = Date.now();
  attachChildHandlers(runtime, child);
  try {
    await waitReady(child);
    runtime.state = "running";
    appendLog(runtime, `[main] MCP server ready (pid=${child.pid})`);
    log.info("mcp child ready", { pid: child.pid });
  } catch (err) {
    runtime.state = "errored";
    runtime.lastError = err instanceof Error ? err.message : String(err);
    runtime.recentFailures.push(Date.now());
    try {
      child.kill("SIGTERM");
    } catch {
      /* noop */
    }
    runtime.child = null;
    runtime.pid = null;
    runtime.startedAt = null;
    appendLog(runtime, `[main] MCP server start failed: ${runtime.lastError}`);
    throw new AppError("mcp_start_failed", runtime.lastError);
  }
}

export async function stop(): Promise<void> {
  if (!runtime) return;
  runtime.enabled = false;
  const child = runtime.child;
  runtime.state = "stopping";
  if (!child) {
    runtime.state = "stopped";
    return;
  }
  await new Promise<void>((resolve) => {
    const onExit = () => resolve();
    child.once("exit", onExit);
    try {
      child.kill("SIGTERM");
    } catch {
      resolve();
    }
    // 兜底
    setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* noop */
      }
      resolve();
    }, 1_500);
  });
  if (runtime) {
    runtime.child = null;
    runtime.pid = null;
    runtime.startedAt = null;
    runtime.state = "stopped";
    appendLog(runtime, "[main] MCP server stopped");
  }
}

export function configSnippet(): McpConfigSnippet {
  if (!runtime) {
    throw new AppError("no_vault", "no vault opened; cannot build MCP config");
  }
  const { command, args, env } = resolveServerSpawn(runtime.vaultPath);
  const config = {
    mcpServers: {
      stela: {
        command,
        args,
        env,
      },
    },
  };
  return {
    json: JSON.stringify(config, null, 2),
    command,
    args,
    env,
  };
}

function attachChildHandlers(rt: Runtime, child: ChildProcess): void {
  if (child.stderr) {
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (data: string) => {
      for (const line of String(data).split(/\r?\n/)) {
        if (line) appendLog(rt, line);
      }
    });
  }
  if (child.stdout) {
    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (data: string) => {
      // MCP JSON-RPC payload 在 stdout；这里仅按行采样到日志（前 200 字符）
      for (const line of String(data).split(/\r?\n/)) {
        if (line) appendLog(rt, line.slice(0, 200));
      }
    });
  }
  child.on("exit", (code, signal) => {
    if (rt !== runtime) return;
    appendLog(
      rt,
      `[main] MCP child exited code=${code ?? "?"} signal=${signal ?? "?"}`,
    );
    rt.child = null;
    rt.pid = null;
    rt.startedAt = null;
    if (rt.state === "starting" || rt.state === "running") {
      rt.state = "stopped";
    }
  });
  child.on("error", (err) => {
    if (rt !== runtime) return;
    rt.lastError = err.message;
    appendLog(rt, `[main] MCP child error: ${err.message}`);
  });
}

function waitReady(child: ChildProcess): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (!child.stdout) return reject(new Error("child has no stdout"));
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`ready marker not received within ${READY_TIMEOUT_MS}ms`));
    }, READY_TIMEOUT_MS);
    let buf = "";
    const onData = (data: string) => {
      buf += String(data);
      if (buf.includes(READY_MARKER)) {
        cleanup();
        resolve();
      }
    };
    const onErr = (data: string) => {
      buf += String(data);
      if (buf.includes(READY_MARKER)) {
        cleanup();
        resolve();
      }
    };
    const onExit = () => {
      cleanup();
      reject(new Error("child exited before ready"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onErr);
      child.off("exit", onExit);
    };
    child.stdout.on("data", onData);
    child.stderr?.on("data", onErr);
    child.once("exit", onExit);
  });
}

function appendLog(rt: Runtime, line: string): void {
  const ts = new Date().toISOString();
  rt.logBuffer.push(`${ts} ${line}`);
  if (rt.logBuffer.length > MAX_LOG_LINES) {
    rt.logBuffer.splice(0, rt.logBuffer.length - MAX_LOG_LINES);
  }
}

/**
 * 解析 child spawn 命令。
 *
 * 优先级：
 *   1. 显式 STELA_MCP_SERVER_PATH（用户指向手工 build 的 cjs）
 *   2. dev：__dirname/../mcp/server.cjs（electron-vite dev 输出）
 *   3. prod：app.asar.unpacked/out/mcp/server.cjs
 *
 * command 永远是 `node`（依赖系统 PATH）。需要打包 Electron-only 时再换成 stela helper exec。
 */
function resolveServerSpawn(vaultPath: string): {
  command: string;
  args: string[];
  env: Record<string, string>;
} {
  const explicit = process.env.STELA_MCP_SERVER_PATH;
  let serverPath: string;
  if (explicit) {
    serverPath = explicit;
  } else {
    // electron-vite 输出：main 进程的 __dirname = `<app>/out/main`
    // mcp child 输出：`<app>/out/main/mcp-server.js`（同目录里另一个 rollup entry）
    serverPath = path.resolve(__dirname, "mcp-server.js");
  }
  return {
    command: process.env.STELA_NODE_BIN || "node",
    args: [serverPath],
    env: {
      STELA_VAULT_PATH: vaultPath,
      // 让 child 同样能找到模型缓存
      STELA_TRANSFORMERS_CACHE_DIR:
        process.env.STELA_TRANSFORMERS_CACHE_DIR ?? "",
    },
  };
}
