/**
 * Machine-local query artifacts used only by Agent execute_python.
 *
 * Paths are derived from hashes and never leave main-process services. The
 * public handle is a successful Agent SQL run id scoped to one local session.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type {
  ColumnDef,
  MaterializedQueryResult,
  QueryArtifactDescriptor,
  QueryArtifactFormat,
  QueryArtifactMode,
  PythonRuntimeInputChunk,
} from "@shared/types";

import { getLogger } from "./logger";
import type { PrivacySession } from './ai/privacy-session';

const log = getLogger("query-artifacts");

export const BUFFERED_ARTIFACT_MAX_BYTES = 64 * 1024 * 1024;
export const ARTIFACT_MAX_BYTES = 1024 * 1024 * 1024;
export const ARTIFACT_CACHE_MAX_BYTES = 4 * 1024 * 1024 * 1024;
export const ARTIFACT_IDLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const ARTIFACT_READ_CHUNK_MAX_BYTES = 4 * 1024 * 1024;

interface StoredQueryArtifact extends QueryArtifactDescriptor {
  vaultKey: string;
  fileName: string;
  /** JSONL fallback uses stable physical keys so duplicate SQL labels are safe. */
  physicalColumns?: string[];
}

export interface QueryArtifactTarget {
  vaultKey: string;
  sessionId: string;
  runId: string;
  format: QueryArtifactFormat;
  finalPath: string;
  tempPath: string;
  metadataPath: string;
}

let artifactRoot: string | null = null;

export function configureQueryArtifactRoot(root: string): void {
  artifactRoot = path.resolve(root);
}

function requireRoot(): string {
  if (!artifactRoot) throw new Error("query artifact root is not configured");
  return artifactRoot;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function vaultKey(vaultPath: string): string {
  return hash(path.resolve(vaultPath));
}

function artifactPaths(
  vaultPath: string,
  sessionId: string,
  runId: string,
  format: QueryArtifactFormat,
): QueryArtifactTarget {
  const vk = vaultKey(vaultPath);
  const dir = path.join(requireRoot(), vk, hash(sessionId));
  const stem = hash(runId);
  const extension = format === "parquet" ? ".parquet" : ".jsonl";
  const finalPath = path.join(dir, `${stem}${extension}`);
  return {
    vaultKey: vk,
    sessionId,
    runId,
    format,
    finalPath,
    tempPath: path.join(dir, `.${stem}.${process.pid}.${Date.now()}.tmp`),
    metadataPath: path.join(dir, `${stem}.artifact.json`),
  };
}

export async function createQueryArtifactTarget(
  vaultPath: string,
  sessionId: string,
  runId: string,
  format: QueryArtifactFormat,
): Promise<QueryArtifactTarget> {
  const target = artifactPaths(vaultPath, sessionId, runId, format);
  await fs.mkdir(path.dirname(target.finalPath), { recursive: true });
  await Promise.all([
    fs.rm(target.tempPath, { force: true }),
    fs.rm(target.finalPath, { force: true }),
    fs.rm(target.metadataPath, { force: true }),
  ]);
  return target;
}

function descriptor(meta: StoredQueryArtifact): QueryArtifactDescriptor {
  const { vaultKey: _vaultKey, fileName: _fileName, physicalColumns: _physicalColumns, ...value } = meta;
  void _vaultKey;
  void _fileName;
  void _physicalColumns;
  return value;
}

async function writeMetadata(target: QueryArtifactTarget, meta: StoredQueryArtifact): Promise<void> {
  const temp = `${target.metadataPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(meta), "utf8");
  await fs.rename(temp, target.metadataPath);
}

async function finishArtifact(
  target: QueryArtifactTarget,
  input: {
    mode: QueryArtifactMode;
    columns: ColumnDef[];
    rowCount: number;
    physicalColumns?: string[];
    sourceRunId?: string;
    privacyMappingDigest?: string;
  },
): Promise<QueryArtifactDescriptor> {
  const stat = await fs.stat(target.tempPath);
  if (!stat.isFile()) throw new Error("connector artifact is not a regular file");
  if (stat.size > ARTIFACT_MAX_BYTES) {
    await fs.rm(target.tempPath, { force: true });
    throw new Error(`query artifact exceeds ${ARTIFACT_MAX_BYTES} bytes`);
  }
  await fs.rename(target.tempPath, target.finalPath);
  const now = Date.now();
  const meta: StoredQueryArtifact = {
    runId: target.runId,
    sessionId: target.sessionId,
    format: target.format,
    mode: input.mode,
    columns: input.columns,
    rowCount: input.rowCount,
    byteSize: stat.size,
    createdAt: now,
    lastAccessedAt: now,
    vaultKey: target.vaultKey,
    fileName: path.basename(target.finalPath),
    physicalColumns: input.physicalColumns,
    sourceRunId: input.sourceRunId,
    privacyMappingDigest: input.privacyMappingDigest,
  };
  await writeMetadata(target, meta);
  void cleanupQueryArtifacts().catch((err) => {
    log.warn("artifact cleanup failed", { err: err instanceof Error ? err.message : String(err) });
  });
  return descriptor(meta);
}

export async function finalizeMaterializedQueryArtifact(
  target: QueryArtifactTarget,
  result: MaterializedQueryResult,
  mode: "parquet-stream" | "jsonl-stream",
): Promise<QueryArtifactDescriptor> {
  return finishArtifact(target, {
    mode,
    columns: result.columns,
    rowCount: result.rowCount,
  });
}

function jsonValue(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return `<base64:${Buffer.from(value).toString("base64")}>`;
  return value;
}

function jsonReplacer(_key: string, value: unknown): unknown {
  return jsonValue(value);
}

/** v1 compatibility path. Returns null rather than creating a partial artifact. */
export async function writeBufferedQueryArtifact(input: {
  vaultPath: string;
  sessionId: string;
  runId: string;
  columns: ColumnDef[];
  rows: unknown[][];
}): Promise<QueryArtifactDescriptor | null> {
  const target = await createQueryArtifactTarget(
    input.vaultPath,
    input.sessionId,
    input.runId,
    "jsonl",
  );
  const physicalColumns = input.columns.map((_, index) => `c${index}`);
  const handle = await fs.open(target.tempPath, "wx");
  let byteSize = 0;
  try {
    for (const row of input.rows) {
      const record: Record<string, unknown> = {};
      for (let index = 0; index < physicalColumns.length; index += 1) {
        record[physicalColumns[index]!] = jsonValue(row[index]);
      }
      const line = `${JSON.stringify(record, jsonReplacer)}\n`;
      byteSize += Buffer.byteLength(line);
      if (byteSize > BUFFERED_ARTIFACT_MAX_BYTES) {
        await handle.close();
        await fs.rm(target.tempPath, { force: true });
        return null;
      }
      await handle.write(line);
    }
    await handle.close();
    return finishArtifact(target, {
      mode: "jsonl-buffered",
      columns: input.columns,
      rowCount: input.rows.length,
      physicalColumns,
    });
  } catch (err) {
    await handle.close().catch(() => {});
    await fs.rm(target.tempPath, { force: true });
    throw err;
  }
}

async function readStored(
  vaultPath: string,
  sessionId: string,
  runId: string,
): Promise<{ meta: StoredQueryArtifact; filePath: string; metadataPath: string } | null> {
  const candidates = (["parquet", "jsonl"] as const).map((format) =>
    artifactPaths(vaultPath, sessionId, runId, format),
  );
  for (const target of candidates) {
    try {
      const raw = await fs.readFile(target.metadataPath, "utf8");
      const meta = JSON.parse(raw) as StoredQueryArtifact;
      if (
        meta.runId !== runId ||
        meta.sessionId !== sessionId ||
        meta.vaultKey !== target.vaultKey ||
        meta.fileName !== path.basename(target.finalPath)
      ) {
        continue;
      }
      const stat = await fs.stat(target.finalPath);
      if (!stat.isFile() || stat.size !== meta.byteSize) continue;
      return { meta, filePath: target.finalPath, metadataPath: target.metadataPath };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        log.warn("invalid artifact metadata", { runId, err: (err as Error).message });
      }
    }
  }
  return null;
}

export async function resolveQueryArtifact(
  vaultPath: string,
  sessionId: string,
  runId: string,
): Promise<QueryArtifactDescriptor | null> {
  const stored = await readStored(vaultPath, sessionId, runId);
  if (!stored) return null;
  stored.meta.lastAccessedAt = Date.now();
  const target = artifactPaths(vaultPath, sessionId, runId, stored.meta.format);
  await writeMetadata(target, stored.meta).catch(() => {});
  return descriptor(stored.meta);
}

export async function readQueryArtifactChunk(input: {
  vaultPath: string;
  sessionId: string;
  runId: string;
  offset: number;
  length: number;
}): Promise<PythonRuntimeInputChunk> {
  const stored = await readStored(input.vaultPath, input.sessionId, input.runId);
  if (!stored) throw new Error("query artifact is missing; rerun the source SQL");
  const offset = Math.max(0, Math.floor(input.offset));
  const length = Math.min(
    ARTIFACT_READ_CHUNK_MAX_BYTES,
    Math.max(1, Math.floor(input.length)),
  );
  const handle = await fs.open(stored.filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(Math.min(length, Math.max(0, stored.meta.byteSize - offset)));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    return {
      data: new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead),
      eof: offset + bytesRead >= stored.meta.byteSize,
    };
  } finally {
    await handle.close();
  }
}

/** Build a separate, complete input before giving generated Python any bytes. */
export async function privateQueryArtifact(input: {
  vaultPath: string; sessionId: string; artifact: QueryArtifactDescriptor;
  privacy: PrivacySession; signal?: AbortSignal; onProgress?: (rows: number, total: number) => void;
}): Promise<QueryArtifactDescriptor> {
  input.signal?.throwIfAborted();
  if (!input.privacy.enabled) return input.artifact;
  if (input.artifact.rowCount === 0) return { ...input.artifact, columns: await Promise.all(input.artifact.columns.map(async c => ({ ...c, name: await input.privacy.maskText(c.name) }))) };
  const stored = await readStored(input.vaultPath, input.sessionId, input.artifact.runId);
  if (!stored) throw new Error('Query artifact is missing; rerun the query.');
  const sourceFingerprint = hash(JSON.stringify([stored.meta.createdAt, stored.meta.byteSize, stored.meta.columns, stored.meta.rowCount]));
  const privateId = `${input.artifact.runId}-privacy-v1-${sourceFingerprint}-${input.privacy.state.namespace}`;
  const cached = await resolveQueryArtifact(input.vaultPath, input.sessionId, privateId);
  // A cached file is usable only with the mapping that created it.
  if (cached && cached.privacyMappingDigest === hash(JSON.stringify(input.privacy.state))) return { ...cached, incomplete: input.artifact.incomplete };
  const target = await createQueryArtifactTarget(input.vaultPath, input.sessionId, privateId, 'parquet');
  const staging = `${target.tempPath}.jsonl`;
  const { DuckDBInstance, JsonDuckDBValueConverter } = await import('@duckdb/node-api');
  const instance = await DuckDBInstance.create(':memory:', { memory_limit: '256MB' });
  const connection = await instance.connect();
  const interrupt = () => connection.interrupt();
  input.signal?.addEventListener('abort', interrupt, { once: true });
  const file = await fs.open(staging, 'wx');
  let rows = 0, bytes = 0;
  try {
    const reader = await connection.stream(stored.meta.format === 'parquet'
      ? 'SELECT * FROM read_parquet(?)'
      : "SELECT * FROM read_json_auto(?, format='newline_delimited', sample_size=-1)", [stored.filePath]);
    if (reader.columnCount !== input.artifact.columns.length) throw new Error('Privacy input column count mismatch');
    const types = reader.columnTypes().map(t => String(t));
    const changed = new Set<number>();
    let chunk;
    while ((chunk = await reader.fetchChunk()) && chunk.rowCount > 0) {
      for (const row of chunk.convertRows(JsonDuckDBValueConverter)) {
        input.signal?.throwIfAborted();
        const record: Record<string, unknown> = {};
        for (let i = 0; i < row.length; i++) {
          const original = row[i];
          const masked = await input.privacy.maskValue(original, input.artifact.columns[i]!.name, input.signal);
          if (JSON.stringify(original) !== JSON.stringify(masked)) changed.add(i);
          record[`c${i}`] = masked;
        }
        const line = JSON.stringify(record) + '\n'; bytes += Buffer.byteLength(line);
        if (bytes > ARTIFACT_MAX_BYTES) throw new Error('Sanitized query exceeds the artifact budget; reduce the query.');
        await file.write(line); rows++;
        if (rows % 256 === 0) input.onProgress?.(rows, input.artifact.rowCount);
      }
    }
    await file.close();
    if (rows !== input.artifact.rowCount) throw new Error('Privacy input row count mismatch');
    const quote = (v: string) => "'" + v.replaceAll("'", "''") + "'";
    const ident = (v: string) => '"' + v.replaceAll('"', '""') + '"';
    const columns = await Promise.all(input.artifact.columns.map(async (c, i) => ({ ...c,
      name: await input.privacy.maskText(c.name), typeName: changed.has(i) ? 'VARCHAR' : types[i]! })));
    // Explicit types prevent a late pseudonym from becoming NULL through inference.
    const schema = types.map((type, i) => `${quote(`c${i}`)}: ${quote(changed.has(i) ? 'VARCHAR' : type)}`).join(',');
    const select = columns.map((c, i) => `${ident(`c${i}`)} AS ${ident(c.name)}`).join(',');
    if (rows) await connection.run(`COPY (SELECT ${select} FROM read_json(${quote(staging)}, format='newline_delimited', columns={${schema}})) TO ${quote(target.tempPath)} (FORMAT PARQUET)`);
    else await connection.run(`COPY (SELECT ${columns.map((c, i) => `CAST(NULL AS ${types[i]}) AS ${ident(c.name)}`).join(',')} WHERE false) TO ${quote(target.tempPath)} (FORMAT PARQUET)`);
    input.signal?.throwIfAborted(); await input.privacy.flush();
    const result = await finishArtifact(target, { mode: 'parquet-stream', columns, rowCount: rows, sourceRunId: input.artifact.runId, privacyMappingDigest: hash(JSON.stringify(input.privacy.state)) });
    input.onProgress?.(rows, rows);
    return { ...result, incomplete: input.artifact.incomplete };
  } catch (e) {
    await file.close().catch(() => {}); await discardQueryArtifactTarget(target); throw e;
  } finally {
    input.signal?.removeEventListener('abort', interrupt); connection.closeSync(); instance.closeSync();
    await fs.rm(staging, { force: true });
  }
}

async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const visit = async (dir: string): Promise<void> => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) out.push(absolute);
    }
  };
  await visit(root);
  return out;
}

export async function cleanupQueryArtifacts(now = Date.now()): Promise<void> {
  const root = requireRoot();
  const allFiles = await walkFiles(root);
  const entries: Array<{ metadataPath: string; filePath: string; meta: StoredQueryArtifact }> = [];
  for (const metadataPath of allFiles.filter((item) => item.endsWith(".artifact.json"))) {
    try {
      const meta = JSON.parse(await fs.readFile(metadataPath, "utf8")) as StoredQueryArtifact;
      if (path.basename(meta.fileName) !== meta.fileName) throw new Error("invalid artifact file name");
      const filePath = path.join(path.dirname(metadataPath), meta.fileName);
      if (!path.resolve(filePath).startsWith(path.resolve(root) + path.sep)) {
        throw new Error("artifact path escapes cache root");
      }
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) throw new Error("not a file");
      entries.push({ metadataPath, filePath, meta: { ...meta, byteSize: stat.size } });
    } catch {
      await fs.rm(metadataPath, { force: true });
    }
  }
  entries.sort((a, b) => b.meta.lastAccessedAt - a.meta.lastAccessedAt);
  let retainedBytes = 0;
  const referenced = new Set<string>();
  for (const entry of entries) {
    const expired = now - entry.meta.lastAccessedAt > ARTIFACT_IDLE_TTL_MS;
    const overBudget = retainedBytes + entry.meta.byteSize > ARTIFACT_CACHE_MAX_BYTES;
    if (expired || overBudget) {
      await Promise.all([
        fs.rm(entry.filePath, { force: true }),
        fs.rm(entry.metadataPath, { force: true }),
      ]);
      continue;
    }
    retainedBytes += entry.meta.byteSize;
    referenced.add(path.resolve(entry.filePath));
    referenced.add(path.resolve(entry.metadataPath));
  }
  for (const filePath of allFiles) {
    if (referenced.has(path.resolve(filePath))) continue;
    try {
      const stat = await fs.stat(filePath);
      if (now - stat.mtimeMs > ARTIFACT_IDLE_TTL_MS) {
        await fs.rm(filePath, { force: true });
      }
    } catch {
      // Concurrent cleanup or artifact finalization; retry on the next pass.
    }
  }
}

export async function discardQueryArtifactTarget(target: QueryArtifactTarget): Promise<void> {
  await fs.rm(target.tempPath, { force: true });
}
