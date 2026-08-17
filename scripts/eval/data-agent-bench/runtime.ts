import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import readline from "node:readline";

export const DAB_ROUTE_PREFIX = "-- stela-dab-database:";

export interface DabTask {
  dataset: string;
  queryId: number;
  queryDir: string;
}

export interface DabValidation {
  timestamp?: string;
  query_name?: string;
  is_valid: boolean;
  reason?: string | null;
  ground_truth?: string;
  llm_answer?: string;
}

interface BridgeResponse {
  id?: string;
  ok?: boolean;
  result?: unknown;
  error?: { code?: string; message?: string; retryable?: boolean };
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

export class DabBridgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly fatal: boolean,
    readonly method?: string,
    readonly timeoutMs?: number,
  ) {
    super(`${code}: ${message}`);
    this.name = "DabBridgeError";
  }
}

export interface DabBridgeOptions {
  dabRoot: string;
  bridgePath: string;
  condaEnv?: string;
  python?: string;
  stderrPath?: string;
  callTimeoutMs?: number;
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  return mapWithResourceConcurrency(items, concurrency, () => [], mapper);
}

export async function mapWithResourceConcurrency<T, R>(
  items: T[],
  concurrency: number,
  resourcesForItem: (item: T, index: number) => readonly string[],
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  const pending = items.map((item, index) => ({
    item,
    index,
    resources: [...new Set(resourcesForItem(item, index))],
  }));
  const activeResources = new Set<string>();
  const limit = Math.min(items.length, Math.max(1, Math.floor(concurrency)));
  let active = 0;
  let completed = 0;
  let firstError: unknown;

  return new Promise<R[]>((resolve, reject) => {
    const schedule = (): void => {
      if (firstError !== undefined) {
        if (active === 0) reject(firstError);
        return;
      }
      if (completed === items.length) {
        resolve(results);
        return;
      }
      while (active < limit) {
        const pendingIndex = pending.findIndex((candidate) =>
          candidate.resources.every((resource) => !activeResources.has(resource)));
        if (pendingIndex < 0) return;
        const [job] = pending.splice(pendingIndex, 1);
        if (!job) return;
        active += 1;
        for (const resource of job.resources) activeResources.add(resource);
        void mapper(job.item, job.index)
          .then((result) => {
            results[job.index] = result;
          })
          .catch((error: unknown) => {
            firstError = error;
          })
          .finally(() => {
            active -= 1;
            completed += 1;
            for (const resource of job.resources) activeResources.delete(resource);
            schedule();
          });
      }
    };
    schedule();
  });
}

export async function readDabDatasetResourceLocks(task: DabTask): Promise<string[]> {
  const config = await fs.readFile(path.join(path.dirname(task.queryDir), "db_config.yaml"), "utf-8");
  return /^\s*db_type\s*:\s*["']?mongo\b/im.test(config) ? ["dab:mongodb"] : [];
}

export function buildDabBridgeCommand(options: DabBridgeOptions): { command: string; args: string[] } {
  if (options.python) {
    return {
      command: options.python,
      args: ["-u", options.bridgePath, "--dab-root", options.dabRoot],
    };
  }
  return {
    command: "conda",
    args: [
      "run",
      "--no-capture-output",
      "-n",
      options.condaEnv ?? "dabench",
      "python",
      "-u",
      options.bridgePath,
      "--dab-root",
      options.dabRoot,
    ],
  };
}

export function buildDabBridgePath(
  dabRoot: string,
  currentPath = process.env.PATH ?? "",
  python?: string,
): string {
  return [path.join(dabRoot, "scripts"), python ? path.dirname(python) : "", currentPath]
    .filter(Boolean)
    .join(path.delimiter);
}

export class DabBridgeClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<string, PendingCall>();
  private exited: Error | null = null;

  constructor(private readonly options: DabBridgeOptions) {}

  async start(): Promise<void> {
    if (this.exited) throw this.exited;
    if (this.child) return;
    const { command, args } = buildDabBridgeCommand(this.options);
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        PATH: buildDabBridgePath(this.options.dabRoot, process.env.PATH ?? "", this.options.python),
      },
    });
    this.child = child;
    const stdout = readline.createInterface({ input: child.stdout });
    stdout.on("line", (line) => this.handleLine(line));
    child.stderr.on("data", (chunk: Buffer) => {
      if (this.options.stderrPath) void fs.appendFile(this.options.stderrPath, chunk);
      else process.stderr.write(chunk);
    });
    child.on("error", (error) => this.failAll(new DabBridgeError("bridge_spawn_error", error.message, true)));
    child.on("exit", (code, signal) => {
      if (this.child === child) this.child = null;
      this.failAll(new DabBridgeError("bridge_exit", `DAB bridge exited (${signal ?? code ?? "unknown"}).`, true));
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
  }

  private handleLine(line: string): void {
    let response: BridgeResponse;
    try {
      response = JSON.parse(line) as BridgeResponse;
    } catch {
      this.failAll(new DabBridgeError("bridge_protocol_error", `DAB bridge emitted invalid JSON: ${line.slice(0, 240)}`, true));
      return;
    }
    if (!response.id) return;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    if (pending.timer) clearTimeout(pending.timer);
    if (response.ok) {
      pending.resolve(response.result);
      return;
    }
    const code = response.error?.code ?? "bridge_error";
    pending.reject(new DabBridgeError(
      code,
      response.error?.message ?? "unknown DAB bridge error",
      false,
    ));
  }

  private failAll(error: Error): void {
    this.exited ??= error;
    const terminal = this.exited;
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(terminal);
    }
    this.pending.clear();
  }

  terminate(reason = "terminated", cause?: Error): void {
    const child = this.child;
    const error = cause ?? new DabBridgeError("bridge_terminated", `DAB bridge ${reason}.`, true);
    this.child = null;
    this.failAll(error);
    if (!child || child.killed) return;
    if (process.platform !== "win32" && child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
        return;
      } catch {
        // Fall back to the direct child if process-group signalling is unavailable.
      }
    }
    child.kill("SIGTERM");
  }

  async call<T>(method: string, params: unknown = {}, timeoutMs = this.options.callTimeoutMs): Promise<T> {
    if (this.exited) throw this.exited;
    await this.start();
    const child = this.child;
    if (!child) throw new Error("DAB bridge is not running.");
    const id = randomUUID();
    const result = new Promise<T>((resolve, reject) => {
      const pending: PendingCall = {
        resolve: (value) => resolve(value as T),
        reject,
        timer: null,
      };
      if (timeoutMs && timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          if (!this.pending.delete(id)) return;
          const error = new DabBridgeError(
            "bridge_call_timeout",
            `DAB bridge call '${method}' timed out after ${timeoutMs}ms.`,
            true,
            method,
            timeoutMs,
          );
          reject(error);
          this.terminate(`call '${method}' timed out`, error);
        }, timeoutMs);
      }
      this.pending.set(id, pending);
    });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    return result;
  }

  async close(): Promise<void> {
    const child = this.child;
    if (!child) return;
    try {
      await this.call("shutdown", {}, Math.min(this.options.callTimeoutMs ?? 5_000, 5_000));
    } catch {
      this.terminate("shutdown failed");
    }
    this.child = null;
  }
}

export function safeSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

export function endpointHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function cacheHitRate(input: number, cacheRead: number, cacheWrite: number): number | null {
  const promptTokens = input + cacheRead + cacheWrite;
  return promptTokens > 0 ? cacheRead / promptTokens : null;
}

export async function discoverDabTasks(dabRoot: string): Promise<DabTask[]> {
  const datasets = (await fs.readdir(dabRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("query_") && entry.name !== "query_dataset")
    .sort((a, b) => a.name.localeCompare(b.name));
  const tasks: DabTask[] = [];
  for (const datasetEntry of datasets) {
    const dataset = datasetEntry.name.slice("query_".length);
    const datasetDir = path.join(dabRoot, datasetEntry.name);
    const queryEntries = (await fs.readdir(datasetDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && /^query\d+$/.test(entry.name))
      .sort((a, b) => Number(a.name.slice(5)) - Number(b.name.slice(5)));
    for (const queryEntry of queryEntries) {
      const queryDir = path.join(datasetDir, queryEntry.name);
      try {
        await fs.access(path.join(queryDir, "query.json"));
        await fs.access(path.join(queryDir, "validate.py"));
      } catch {
        continue;
      }
      tasks.push({ dataset, queryId: Number(queryEntry.name.slice(5)), queryDir });
    }
  }
  return tasks;
}

export async function readDabPrompt(task: DabTask, hints: boolean): Promise<{
  query: string;
  databaseDescription: string;
  hintsText: string;
}> {
  const datasetDir = path.dirname(task.queryDir);
  const rawQuery = JSON.parse(await fs.readFile(path.join(task.queryDir, "query.json"), "utf-8")) as unknown;
  const query = typeof rawQuery === "string"
    ? rawQuery
    : rawQuery && typeof rawQuery === "object" && "query" in rawQuery
      ? String((rawQuery as { query: unknown }).query)
      : "";
  if (!query.trim()) throw new Error(`Unrecognized query.json: ${task.queryDir}`);
  const databaseDescription = (await fs.readFile(path.join(datasetDir, "db_description.txt"), "utf-8")).trim();
  const hintsText = hints
    ? (await fs.readFile(path.join(datasetDir, "db_description_withhint.txt"), "utf-8")).trim()
    : "";
  return { query: query.trim(), databaseDescription, hintsText };
}

export function buildDabUserPrompt(input: {
  query: string;
  databaseDescription: string;
  hintsText: string;
}, capabilities: { pythonAvailable: boolean } = { pythonAvailable: true }): string {
  const sections = [
    "DATABASE DESCRIPTION:\n" + input.databaseDescription,
    input.hintsText ? "DATASET HINTS:\n" + input.hintsText : "",
    `ACTIVE CONNECTION CONTRACT:\n` +
      `- This is a product-faithful Stela benchmark connection. Use Stela's existing tools only.\n` +
      `- Each run_query call targets exactly one logical database through its database field. Use language=sql for PostgreSQL/SQLite/DuckDB and language=mongodb for MongoDB collections.\n` +
      `- MongoDB supports structured read-only find and safe aggregate operations. Prefer aggregate for grouping, ranking, string expressions, and counts.\n` +
      `- Query different logical databases separately; do not join them in one database query.\n` +
      (capabilities.pythonAvailable
        ? `- Successful run_query results can be combined through their artifacts with execute_python. Use DuckDB/pandas there for exact cross-database joins and large calculations.`
        : `- Python execution is disabled for this legacy baseline; report the capability boundary instead of inventing a cross-database answer.`),
    "QUERY:\n" + input.query,
  ];
  return sections.filter(Boolean).join("\n\n");
}

export async function appendJsonl(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, "utf-8");
}

export async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}
