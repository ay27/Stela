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
}

export interface DabBridgeOptions {
  dabRoot: string;
  bridgePath: string;
  condaEnv?: string;
  python?: string;
  stderrPath?: string;
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

export function buildDabBridgePath(dabRoot: string, currentPath = process.env.PATH ?? ""): string {
  return [path.join(dabRoot, "scripts"), currentPath].filter(Boolean).join(path.delimiter);
}

export class DabBridgeClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<string, PendingCall>();
  private exited: Error | null = null;

  constructor(private readonly options: DabBridgeOptions) {}

  async start(): Promise<void> {
    if (this.child) return;
    const { command, args } = buildDabBridgeCommand(this.options);
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PATH: buildDabBridgePath(this.options.dabRoot) },
    });
    this.child = child;
    const stdout = readline.createInterface({ input: child.stdout });
    stdout.on("line", (line) => this.handleLine(line));
    child.stderr.on("data", (chunk: Buffer) => {
      if (this.options.stderrPath) void fs.appendFile(this.options.stderrPath, chunk);
      else process.stderr.write(chunk);
    });
    child.on("error", (error) => this.failAll(error));
    child.on("exit", (code, signal) => {
      this.failAll(new Error(`DAB bridge exited (${signal ?? code ?? "unknown"}).`));
      this.child = null;
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
      this.failAll(new Error(`DAB bridge emitted invalid JSON: ${line.slice(0, 240)}`));
      return;
    }
    if (!response.id) return;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    if (response.ok) {
      pending.resolve(response.result);
      return;
    }
    const code = response.error?.code ?? "bridge_error";
    pending.reject(new Error(`${code}: ${response.error?.message ?? "unknown DAB bridge error"}`));
  }

  private failAll(error: Error): void {
    this.exited = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  async call<T>(method: string, params: unknown = {}): Promise<T> {
    await this.start();
    if (this.exited) throw this.exited;
    const child = this.child;
    if (!child) throw new Error("DAB bridge is not running.");
    const id = randomUUID();
    const result = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
    });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    return result;
  }

  async close(): Promise<void> {
    const child = this.child;
    if (!child) return;
    try {
      await this.call("shutdown", {});
    } catch {
      child.kill("SIGTERM");
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
}): string {
  const sections = [
    "DATABASE DESCRIPTION:\n" + input.databaseDescription,
    input.hintsText ? "DATASET HINTS:\n" + input.hintsText : "",
    `ACTIVE CONNECTION CONTRACT:\n` +
      `- This is a product-faithful Stela benchmark connection. Use Stela's existing tools only.\n` +
      `- Each run_sql call targets exactly one logical database. Its first non-empty line must be '${DAB_ROUTE_PREFIX} <logical_name>'.\n` +
      `- Query different logical databases separately; do not join them in one SQL statement. Combine returned values in your analysis.\n` +
      `- No Python execution tool is available. MongoDB logical databases cannot be queried by Stela's SQL-only run_sql.`,
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
