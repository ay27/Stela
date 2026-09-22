/** Stela persistence boundary for Pi's durable main lane (ADR-0113). */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  BACKGROUND_CONTEXT as context, JsonlSessionRepo, MemorySessionRepo,
  createCompactionSummaryMessage, createBranchSummaryMessage, convertToLlm,
  ok, getOrThrow, type FileSystem, type Entry, type EntryProjector,
  type Session as NativeSession, type AgentLane, type AgentMessage, type JsonValue,
} from '@earendil-works/pi-agent-core';
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node';

export type SessionTreeEntry = Entry;
export const jsonValue = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value));
export interface IJournalIO {
  readTextFile: FileSystem['readTextFile'];
  readTextLines: FileSystem['readTextLines'];
  writeFile: FileSystem['writeFile'];
  appendFile: FileSystem['appendFile'];
}

export async function loadJsonlSessionMetadata(io: IJournalIO, file: string) {
  const raw = getOrThrow(await io.readTextFile(file, context));
  const header = JSON.parse(raw.split('\n')[0]);
  if (header.v === 4 && header.kind === 'header') return { ...header, path: file, modifiedAt: Date.now() };
  if (header.type !== 'session' || header.version !== 3) throw new Error('Unsupported Pi session format');
  return { id: header.id, createdAt: Date.parse(header.timestamp), cwd: header.cwd,
    storageVersion: 1, path: file, modifiedAt: Date.now() };
}

/** Embedded journals use Pi's atomic rename protocol, publishing only complete snapshots. */
function journalFileSystem(io: IJournalIO, file: string, cwd: string): FileSystem {
  const base = new NodeExecutionEnv({ cwd });
  const temporary = new Map<string, string>();
  const decode = (v: string | Uint8Array) => typeof v === 'string' ? v : new TextDecoder().decode(v);
  return new Proxy(base, {
    get(target, key) {
      if (key === 'readTextFile') return async (p: string) => p === file ? io.readTextFile(p, context) : ok(temporary.get(p) ?? '');
      if (key === 'openTextLineReader') return async (p: string) => {
        const text = p === file ? getOrThrow(await io.readTextFile(p, context)) : temporary.get(p) ?? '';
        const lines = text.split('\n'); if (lines.at(-1) === '') lines.pop(); let index = 0;
        return ok({ readLine: async () => ok(index < lines.length ? { text: lines[index++], terminated: true } : undefined), close: async () => {} });
      };
      if (key === 'writeFile') return async (p: string, value: string | Uint8Array) => {
        if (p === file) return io.writeFile(p, value, context);
        temporary.set(p, decode(value)); return ok(undefined);
      };
      if (key === 'appendFile') return async (p: string, value: string | Uint8Array) => {
        if (p === file) return io.appendFile(p, value, context);
        temporary.set(p, (temporary.get(p) ?? '') + decode(value)); return ok(undefined);
      };
      if (key === 'renameFile') return async (from: string, to: string) => {
        if (to !== file || !temporary.has(from)) throw new Error('Invalid journal publication');
        const result = await io.writeFile(file, temporary.get(from)!, context);
        if (result.ok) temporary.delete(from); return result;
      };
      if (key === 'exists') return async (p: string) => ok(p === file || temporary.has(p));
      if (key === 'remove') return async (p: string) => { temporary.delete(p); return ok(undefined); };
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export class JsonlSessionStorage {
  lane?: AgentLane;
  constructor(readonly native: NativeSession) {}
  static async open(io: IJournalIO, file: string) {
    const metadata = await loadJsonlSessionMetadata(io, file);
    const isDisk = io instanceof NodeExecutionEnv;
    let fileSystem: FileSystem;
    if (isDisk) {
      fileSystem = new Proxy(io, { get(target, key) {
        if (key === 'renameFile') return async (from: string, to: string) => {
          if (to === file) {
            const raw = await fs.readFile(file, 'utf8');
            if (JSON.parse(raw.split('\n')[0]).version === 3) {
              try { await fs.writeFile(`${file}.pre-pi087.bak`, raw, { flag: 'wx', mode: 0o600 }); }
              catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
            }
          }
          return target.renameFile(from, to, context);
        };
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
      } });
    } else fileSystem = journalFileSystem(io, file, metadata.cwd);
    const repo = new JsonlSessionRepo({ fileSystem, sessionsRoot: path.dirname(file) });
    return new JsonlSessionStorage(await repo.open(metadata, context));
  }
  static async create(io: IJournalIO, file: string, options: { cwd: string; sessionId: string; metadata?: unknown }) {
    // Open a native format-4 journal at the exact Stela-owned path.
    getOrThrow(await io.writeFile(file, JSON.stringify({ v: 4, kind: 'header', storageVersion: 1, id: options.sessionId,
      createdAt: Date.now(), cwd: options.cwd }) + '\n', context));
    return this.open(io, file);
  }
  getEntries() { return this.native.findEntries({ order: 'asc' }, context); }
  async branch() { return await this.native.branch('main', context) ?? await this.native.createBranch('main', null, context); }
  async appendCustomEntry(customType: string, data: unknown) {
    return (this.lane ?? await this.branch()).appendCustomEntry(customType, jsonValue(data), context);
  }
}
export class InMemorySessionStorage {
  readonly ready = new MemorySessionRepo().create({ id: randomUUID() }, context);
}
export class Session {
  readonly ready: Promise<NativeSession>;
  lane?: AgentLane;
  constructor(readonly storage: JsonlSessionStorage | InMemorySessionStorage = new InMemorySessionStorage(), readonly options: {
    entryTransforms?: ((entries: readonly Entry[]) => Entry[])[];
    entryProjectors?: Record<string, EntryProjector>;
  } = {}) { this.ready = storage instanceof JsonlSessionStorage ? Promise.resolve(storage.native) : storage.ready; }
  async getEntries() { return (await this.ready).findEntries({ order: 'asc' }, context); }
  async branch() {
    const native = await this.ready;
    return await native.branch('main', context) ?? await native.createBranch('main', null, context);
  }
  async getBranch() {
    let entries = await (await this.branch()).findEntries({ order: 'oldestFirst' }, context);
    for (const transform of this.options.entryTransforms ?? []) entries = transform(entries);
    return entries;
  }
  async appendCustomEntry(type: string, data: unknown) {
    return (this.lane ?? await this.branch()).appendCustomEntry(type, jsonValue(data), context);
  }
  async appendMessage(message: AgentMessage) { return (this.lane ?? await this.branch()).appendMessage(message, context); }
  async buildContext() {
    let messages: AgentMessage[] = [];
    for (const entry of await this.getBranch()) {
      if (entry.type === 'message') messages.push(entry.message);
      else if (entry.type === 'compaction') messages = [createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp), ...entry.retainedTail];
      else if (entry.type === 'branch_summary') messages.push(createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp));
      else if (entry.type === 'custom') messages.push(...await this.options.entryProjectors?.[entry.customType]?.(entry, context) ?? []);
    }
    return { messages: convertToLlm(messages) };
  }
}
