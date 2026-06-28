/**
 * Subprocess connector：通过 stdin/stdout 行分隔 JSON-RPC 与外部插件通信。
 *
 * 协议（v1）：
 *   1. 启动 → 子进程吐第一行 `{ method: "hello", result: ConnectorKindMeta }` 完成握手
 *   2. 主进程发 `{ id, method, params }`，子进程回 `{ id, ok, result|error }`
 *   3. 单实例并发：内部 mutex 串行；超时（默认 60s）杀掉重启
 *
 * 注意：本类**只在 main 进程使用**，与 renderer 完全隔离。
 *
 * TODO(stub Phase 5): 当前已能 spawn + 发请求，但缺乏：
 *   - 心跳 / 健康检查
 *   - stderr 限流（避免插件刷屏拖死 main）
 *   - shutdown 命令的优雅关闭流程（目前仅靠 kill_on_drop）
 */

import { ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import readline from "node:readline";

import { AppError } from "@shared/errors";
import type {
  ConnectorKindMeta,
  QueryResult,
  TestResult,
} from "@shared/types";

import type { Connector } from "./types";

export interface PluginEntry {
  kind: string;
  exePath: string;
  args?: string[];
  env?: Record<string, string>;
}

interface RpcEnvelope {
  id?: string;
  ok?: boolean;
  result?: unknown;
  error?: { code: string; message: string; retryable?: boolean };
  method?: string;
}

interface ProcHandle {
  child: ChildProcess;
  rl: readline.Interface;
  lineBuffer: string[];
  resolveLine: ((s: string) => void) | null;
  /** stderr ring buffer。最近若干行；旧的从前面丢弃 */
  stderrRing: string[];
  stderrRl?: readline.Interface;
}

const REQUEST_TIMEOUT_MS = 60_000;
const HELLO_TIMEOUT_MS = 5_000;
const STDERR_RING_SIZE = 200;

class Lock {
  private p: Promise<void> = Promise.resolve();
  async run<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const next = new Promise<void>((res) => (release = res));
    const prev = this.p;
    this.p = prev.then(() => next);
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

async function spawnChild(entry: PluginEntry): Promise<ProcHandle> {
  const child = spawn(entry.exePath, entry.args ?? [], {
    env: { ...process.env, ...(entry.env ?? {}) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (!child.stdin || !child.stdout) {
    throw new AppError("spawn_failed", "child stdio not piped");
  }
  const rl = readline.createInterface({ input: child.stdout });
  const handle: ProcHandle = {
    child,
    rl,
    lineBuffer: [],
    resolveLine: null,
    stderrRing: [],
  };
  rl.on("line", (line) => {
    if (handle.resolveLine) {
      const r = handle.resolveLine;
      handle.resolveLine = null;
      r(line);
    } else {
      handle.lineBuffer.push(line);
    }
  });
  if (child.stderr) {
    const stderrRl = readline.createInterface({ input: child.stderr });
    handle.stderrRl = stderrRl;
    stderrRl.on("line", (line) => {
      handle.stderrRing.push(line);
      if (handle.stderrRing.length > STDERR_RING_SIZE) {
        handle.stderrRing.splice(
          0,
          handle.stderrRing.length - STDERR_RING_SIZE,
        );
      }
    });
  }
  return handle;
}

function readLine(
  handle: ProcHandle,
  timeoutMs: number,
): Promise<string> {
  if (handle.lineBuffer.length > 0) {
    return Promise.resolve(handle.lineBuffer.shift()!);
  }
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      handle.resolveLine = null;
      reject(new AppError("timeout", `subprocess timed out after ${timeoutMs}ms`, true));
    }, timeoutMs);
    handle.resolveLine = (s: string) => {
      clearTimeout(t);
      resolve(s);
    };
  });
}

async function readHello(handle: ProcHandle): Promise<ConnectorKindMeta> {
  const line = await readLine(handle, HELLO_TIMEOUT_MS);
  const frame = JSON.parse(line) as RpcEnvelope;
  if (frame.method !== "hello" || !frame.result) {
    throw new AppError(
      "bad_handshake",
      `expected method=hello, got ${frame.method ?? "?"}`,
    );
  }
  return frame.result as ConnectorKindMeta;
}

export class SubprocessConnector implements Connector {
  private metaCache: ConnectorKindMeta;
  private entry: PluginEntry;
  private handle: ProcHandle | null = null;
  private lock = new Lock();

  constructor(meta: ConnectorKindMeta, entry: PluginEntry, handle: ProcHandle) {
    this.metaCache = meta;
    this.entry = entry;
    this.handle = handle;
  }

  static async spawnFromEntry(entry: PluginEntry): Promise<SubprocessConnector> {
    const handle = await spawnChild(entry);
    const meta = await readHello(handle);
    return new SubprocessConnector(meta, entry, handle);
  }

  meta(): ConnectorKindMeta {
    return this.metaCache;
  }

  /** 当前子进程是否仍然存活（不强制启动，只查现状） */
  isAlive(): boolean {
    return !!this.handle && !this.handle.child.killed;
  }

  /** 进程 PID，未启动时为 null */
  pid(): number | null {
    return this.handle?.child.pid ?? null;
  }

  /** 暴露 entry 信息给上层（用于 UI 列出 exePath / args） */
  getEntry(): PluginEntry {
    return this.entry;
  }

  /** 取最近若干行 stderr。按时间顺序，旧→新 */
  getRecentStderr(): string[] {
    return this.handle ? [...this.handle.stderrRing] : [];
  }

  private async ensureAlive(): Promise<ProcHandle> {
    if (this.handle && !this.handle.child.killed) return this.handle;
    const handle = await spawnChild(this.entry);
    await readHello(handle);
    this.handle = handle;
    return handle;
  }

  /**
   * 显式启动子进程：当前活的 → no-op；当前死的 → spawn + handshake。
   *
   * 用于 plugins-tab 的「Start」按钮——给运维人员一个确定的「现在就把它拉起来」入口；
   * 内部 RPC 调用本来就会经过 ensureAlive 自动重启，但 UI 上需要一个不依赖
   * 用户跑 SQL 的显式控制。
   */
  async start(): Promise<void> {
    await this.lock.run(async () => {
      await this.ensureAlive();
    });
  }

  private async call(method: string, params: unknown): Promise<unknown> {
    return this.lock.run(async () => {
      const handle = await this.ensureAlive();
      const id = randomUUID();
      const payload = JSON.stringify({ id, method, params }) + "\n";
      try {
        if (!handle.child.stdin?.write(payload)) {
          await new Promise((r) =>
            handle.child.stdin?.once("drain", () => r(undefined)),
          );
        }
      } catch (err) {
        this.killChild();
        throw new AppError(
          "write_failed",
          (err as Error).message ?? "write failed",
          true,
        );
      }
      let line: string;
      try {
        line = await readLine(handle, REQUEST_TIMEOUT_MS);
      } catch (err) {
        this.killChild();
        throw err;
      }
      const env = JSON.parse(line) as RpcEnvelope;
      if (!env.ok) {
        const e = env.error ?? {
          code: "plugin_error",
          message: "unknown",
          retryable: false,
        };
        throw new AppError(e.code, e.message, e.retryable === true);
      }
      return env.result;
    });
  }

  private killChild(): void {
    if (this.handle) {
      try {
        this.handle.child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      this.handle = null;
    }
  }

  async test(cfg: unknown): Promise<TestResult> {
    return (await this.call("test", { config: cfg })) as TestResult;
  }
  async execute(cfg: unknown, sql: string): Promise<QueryResult> {
    return (await this.call("execute", { config: cfg, sql })) as QueryResult;
  }
  async listDatabases(cfg: unknown): Promise<string[]> {
    return (await this.call("list_databases", { config: cfg })) as string[];
  }
  async listTables(cfg: unknown, db?: string | null): Promise<string[]> {
    return (await this.call("list_tables", {
      config: cfg,
      db: db ?? null,
    })) as string[];
  }

  shutdown(): void {
    this.killChild();
  }
}
