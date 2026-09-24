import { randomBytes } from 'node:crypto';
import { privacyStateSchema, PRIVACY_TOKEN_SOURCE, type IPrivacySessionState, type IPrivacyDisplay } from '../../shared/ai-privacy';
import { detectPrivacy } from './privacy-engine';
import { redactForPrompt } from './redaction';

export interface IPrivacyPersistence {
  state?: IPrivacySessionState;
  save(state: IPrivacySessionState): Promise<void>;
}
const LIMIT = 64 * 1024 * 1024;
export class PrivacySession {
  readonly state: IPrivacySessionState;
  private readonly byOriginal = new Map<string, string>();
  private readonly byToken = new Map<string, IPrivacySessionState['entries'][number]>();
  private revision = 0;
  private savedRevision = 0;
  private size = 0;
  private readonly detections = new Map<string, string>();
  private writes: Promise<void> = Promise.resolve();
  constructor(readonly enabled: boolean, private persistence?: IPrivacyPersistence) {
    this.state = persistence?.state ? privacyStateSchema.parse(persistence.state) : { version: 1, namespace: randomBytes(12).toString('hex'), entries: [] };
    for (const entry of this.state.entries) {
      if (!entry.token.startsWith(`STELA_PII_${this.state.namespace}_`)) throw new Error('Invalid privacy token namespace');
      if (this.byToken.has(entry.token) || this.byOriginal.has(entry.original)) throw new Error('Conflicting privacy mapping');
      this.byToken.set(entry.token, entry); this.byOriginal.set(entry.original, entry.token);
    }
    this.size = Buffer.byteLength(JSON.stringify(this.state));
    if (this.size > LIMIT) throw new Error('Privacy mapping exceeds 64 MiB');
  }
  private token(original: string, kind: string): string {
    const found = this.byOriginal.get(original); if (found) return found;
    let token: string;
    do { token = `STELA_PII_${this.state.namespace}_${randomBytes(12).toString('hex')}`; } while (this.byToken.has(token));
    const entry = { token, original, kind };
    const bytes = Buffer.byteLength(JSON.stringify(entry)) + 1;
    if (this.size + bytes > LIMIT) throw new Error('Privacy mapping exceeds 64 MiB; reduce the query scope.');
    this.size += bytes; this.revision++;
    this.state.entries.push(entry); this.byToken.set(token, entry); this.byOriginal.set(original, token);
    return token;
  }
  importIdentity(original: string, kind: string): string { return this.token(original, kind); }
  async maskText(text: string, label = '', signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    if (!this.enabled || !text) return text;
    const existing = this.byOriginal.get(text); if (existing) return existing;
    const cacheKey = `${label}\0${text}`;
    const cached = this.detections.get(cacheKey); if (cached !== undefined) return cached;
    // Tokens are opaque. Do not interpret their randomly generated digits as PII.
    const parts = text.split(new RegExp(`(${PRIVACY_TOKEN_SOURCE})`, 'g'));
    const indices = parts.map((_, i) => i).filter(i => i % 2 === 0 && parts[i]);
    if (!indices.length) return text;
    const personLabel = /^(?:(?:customer|user|person|employee|contact|full|first|last)[_ -]?name|姓名|客户姓名|用户姓名|联系人|员工姓名)$/i.test(label);
    const prefix = personLabel ? "客户姓名：" : label ? `${JSON.stringify(label)}: \"` : '';
    const suffix = label && !personLabel ? '\"' : '';
    const spans = await detectPrivacy(indices.map(i => prefix + parts[i] + suffix), signal);
    for (let n = 0; n < indices.length; n++) {
      const i = indices[n]!; const original = parts[i]!; let out = ''; let at = 0;
      for (const span of spans[n]!) {
        if (span.end <= prefix.length) continue;
        const start = Math.max(0, span.start - prefix.length), end = span.end - prefix.length;
        if (start < at || end > original.length) throw new Error('Invalid privacy span');
        out += original.slice(at, start) + this.token(original.slice(start, end), span.kind); at = end;
      }
      parts[i] = out + original.slice(at);
    }
    const output = parts.join('');
    if (text.length < 4096) {
      if (this.detections.size >= 1024) this.detections.delete(this.detections.keys().next().value!);
      this.detections.set(cacheKey, output);
    }
    return output;
  }
  async maskValue(value: unknown, label = '', signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    if (!this.enabled) return value;
    if (/\b(password|passwd|pwd|token|secret|api[_-]?key|authorization|bearer)\b/i.test(label)) return '***redacted***';
    if (typeof value === 'string') return this.maskText(value, label, signal);
    if (typeof value === 'number' && Number.isFinite(value)) {
      const original = String(value), masked = await this.maskText(original, label, signal);
      return masked === original ? value : masked;
    }
    if (Array.isArray(value)) {
      const out: unknown[] = []; for (const v of value) out.push(await this.maskValue(v, label, signal)); return out;
    }
    if (value && typeof value === 'object') {
      const object = value as Record<string, unknown>;
      if (Array.isArray(object.columns) && Array.isArray(object.rows)) {
        const rest = Object.fromEntries(Object.entries(object).filter(([key]) => key !== 'rows'));
        const out = await this.maskValue(rest, label, signal) as Record<string, unknown>;
        const columns = object.columns;
        out.rows = await Promise.all(object.rows.map(async row => Array.isArray(row) ? Promise.all(row.map((cell, i) => {
          const col = columns[i]; const name = typeof col === 'string' ? col : col && typeof col === 'object' && 'name' in col ? String(col.name) : '';
          return this.maskValue(cell, name, signal);
        })) : this.maskValue(row, label, signal)));
        return out;
      }
      const out: Record<string, unknown> = {};
      for (const [key, v] of Object.entries(value)) Object.defineProperty(out, await this.maskText(key, '', signal), {
        value: await this.maskValue(v, key, signal), enumerable: true, configurable: true, writable: true,
      });
      return out;
    }
    return value;
  }
  async flush(): Promise<void> {
    this.writes = this.writes.then(async () => {
      if (this.savedRevision === this.revision) return;
      const revision = this.revision;
      await this.persistence?.save(structuredClone(this.state));
      this.savedRevision = revision;
    });
    return this.writes;
  }
  setPersistence(persistence: IPrivacyPersistence) { this.persistence = persistence; }
  display(value: unknown): IPrivacyDisplay {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    const tokens = [...new Set(text.match(new RegExp(PRIVACY_TOKEN_SOURCE, 'g')) ?? [])];
    return { enabled: this.enabled, annotations: tokens.flatMap(token => {
      const e = this.byToken.get(token); return e ? [{ token, original: e.original }] : [];
    }) };
  }
  restoreValue(value: unknown): unknown {
    if (typeof value === 'string') return this.restore(value);
    if (Array.isArray(value)) return value.map(v => this.restoreValue(v));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [this.restore(k), this.restoreValue(v)]));
    return value;
  }
  restore(text: string): string {
    return text.replace(new RegExp(PRIVACY_TOKEN_SOURCE, 'g'), token => {
      const entry = this.byToken.get(token);
      if (!entry) throw new Error('Unknown privacy token; query was not executed.');
      return entry.original;
    });
  }
  /** Restore structured output after parsing so quotes in identities remain escaped. */
  restoreOutput(text: string): string {
    let value: unknown;
    try { value = JSON.parse(text); } catch { return this.restore(text); }
    return JSON.stringify(this.restoreValue(value));
  }
  private async maskContent(text: string, signal?: AbortSignal): Promise<string> {
    let value: unknown;
    try { value = JSON.parse(text); } catch { return this.maskText(redactForPrompt(text), '', signal); }
    return JSON.stringify(await this.maskValue(redactForPrompt(value), '', signal));
  }
  private async maskSchema(value: unknown, signal?: AbortSignal): Promise<unknown> {
    if (Array.isArray(value)) return Promise.all(value.map(v => this.maskSchema(v, signal)));
    if (!value || typeof value !== 'object') return value;
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      // Keep schema property identifiers and types intact; redact human prose and examples.
      if (['properties', '$defs', 'definitions', 'patternProperties'].includes(key) && v && typeof v === 'object') {
        out[key] = Object.fromEntries(await Promise.all(Object.entries(v).map(async ([name, schema]) => [name, await this.maskSchema(schema, signal)])));
        continue;
      }
      out[key] = ['description', 'title', 'default', 'examples', 'enum', 'const'].includes(key)
        ? await this.maskValue(redactForPrompt(v), '', signal) : await this.maskSchema(v, signal);
    }
    return out;
  }
  /** Filter semantic text, leaving protocol names and provider signatures intact. */
  async context<T>(input: T, signal?: AbortSignal): Promise<T> {
    if (!this.enabled) {
      const restoreKnown = (v: unknown): unknown => typeof v === "string" ? v.replace(new RegExp(PRIVACY_TOKEN_SOURCE, "g"), token => this.byToken.get(token)?.original ?? token) : Array.isArray(v) ? v.map(restoreKnown) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, restoreKnown(x)])) : v;
      return restoreKnown(input) as T;
    }
    const copy = structuredClone(input) as Record<string, unknown>;
    if (typeof copy.systemPrompt === 'string') copy.systemPrompt = await this.maskText(redactForPrompt(copy.systemPrompt), '', signal);
    if (Array.isArray(copy.messages)) for (const m of copy.messages as Record<string, unknown>[]) {
      if (typeof m.content === 'string') m.content = await this.maskContent(m.content, signal);
      else if (Array.isArray(m.content)) for (const block of m.content as Record<string, unknown>[]) {
        if (!['text', 'thinking', 'toolCall'].includes(String(block.type))) throw new Error('Privacy mode does not support non-text model inputs.');
        for (const key of ['text', 'thinking']) if (typeof block[key] === 'string') block[key] = await this.maskContent(block[key], signal);
        if (block.arguments) block.arguments = await this.maskValue(redactForPrompt(block.arguments), '', signal);
      }
    }
    if (Array.isArray(copy.tools)) for (const t of copy.tools as Record<string, unknown>[]) {
      if (typeof t.description === 'string') t.description = await this.maskText(t.description, '', signal);
      if (t.parameters) t.parameters = await this.maskSchema(t.parameters, signal);
    }
    await this.flush(); signal?.throwIfAborted(); return copy as T;
  }
}

// Foreground turns and their background maintenance must share one live map.
const live = new Map<string, PrivacySession>();
export function openPrivacySession(key: string, enabled: boolean, persistence: IPrivacyPersistence): PrivacySession {
  const existing = live.get(key);
  if (!enabled) return new PrivacySession(false, { ...persistence, state: existing?.state ?? persistence.state });
  if (existing && (!persistence.state || existing.state.namespace === persistence.state.namespace)) {
    for (const entry of persistence.state?.entries ?? []) {
      const current = existing.state.entries.find(e => e.token === entry.token);
      if (!current || current.original !== entry.original) throw new Error('Privacy conversation changed externally; reopen the application before continuing.');
    }
    existing.setPersistence(persistence); return existing;
  }
  const created = new PrivacySession(true, persistence); live.set(key, created); return created;
}
