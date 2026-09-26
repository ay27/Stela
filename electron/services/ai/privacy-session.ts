import { randomBytes, randomInt } from 'node:crypto';
import { privacyStateSchema, PRIVACY_TOKEN_SOURCE, type IPrivacySessionState, type IPrivacyDisplay, type IPrivacyResultDisplay } from '../../shared/ai-privacy';
import { countColumns, parseJsonContainer, releaseOptions, secretLabel, selectionAllows, structuralKey, type IPrivacySource, type IPrivacySelection, type IPrivacyReleaseRequest } from './privacy-policy';
import { redactForPrompt } from './redaction';

export interface IPrivacyPersistence {
  state?: IPrivacySessionState;
  save(state: IPrivacySessionState): Promise<void>;
}
const LIMIT = 64 * 1024 * 1024;
interface IIdentityStore {
  state: IPrivacySessionState;
  byOriginal: Map<string, string>;
  byToken: Map<string, IPrivacySessionState['entries'][number]>;
  revision: number; savedRevision: number; size: number;
  writes: Promise<void>; persistence?: IPrivacyPersistence;
  codes: Map<number, { remaining: number; swaps: Map<number, number> }>;
}
interface IReleaseCall { id: string; runId: string; reason: string }
export class PrivacySession {
  private identity: IIdentityStore;
  get state(): IPrivacySessionState { return this.identity.state; }
  readonly taskId = randomBytes(12).toString('hex');
  private active = true;
  private grantRevision = 0;
  private sources = new Map<string, IPrivacySource>();
  private numericCounts = new Map<string, Set<number>>();
  private grants = new Map<string, IPrivacySelection[]>();
  private outputs = new Map<string, { name: string; masked: string; projected: string }>();
  private resultDisplays = new Map<string, IPrivacyResultDisplay[]>();
  private outputBytes = 0;
  private sourceBytes = 0;
  private recipients: string[] = [];
  private releaseBatch?: { calls: IReleaseCall[]; decision?: Promise<void> };
  private derived = false;
  private scopeOwner?: PrivacySession;
  private matcherRevision = -1;
  private matcher: Array<{ edges: Map<string, number>; token?: string }> = [];
  constructor(readonly enabled: boolean, persistence?: IPrivacyPersistence, identity?: IIdentityStore) {
    if (identity) { this.identity = identity; return; }
    this.identity = { state: { version: 2, namespace: randomBytes(12).toString('hex'), entries: [] },
      byOriginal: new Map(), byToken: new Map(), revision: 0, savedRevision: 0, size: 0,
      writes: Promise.resolve(), persistence, codes: new Map() };
    if (persistence?.state) this.identity.state = privacyStateSchema.parse(persistence.state);
    for (const entry of this.state.entries) {
      if (entry.token.startsWith('STELA_PII_') && !entry.token.startsWith(`STELA_PII_${this.state.namespace}_`)) throw new Error('Invalid privacy token namespace');
      if (this.identity.byToken.has(entry.token) || this.identity.byOriginal.has(entry.original)) throw new Error('Conflicting privacy mapping');
      this.identity.byToken.set(entry.token, entry); this.identity.byOriginal.set(entry.original, entry.token);
    }
    this.identity.size = Buffer.byteLength(JSON.stringify(this.state));
    if (this.identity.size > LIMIT) throw new Error('Privacy mapping exceeds 64 MiB');
  }
  private token(original: string, kind: string): string {
    const found = this.identity.byOriginal.get(original); if (found) return found;
    const token = this.allocateCode(original);
    const entry = { token, original, kind };
    const bytes = Buffer.byteLength(JSON.stringify(entry)) + 1;
    if (this.identity.size + bytes > LIMIT) throw new Error('Privacy mapping exceeds 64 MiB; reduce the query scope.');
    this.identity.size += bytes; this.identity.revision++;
    this.state.version = 2;
    this.state.entries.push(entry); this.identity.byToken.set(token, entry); this.identity.byOriginal.set(original, token);
    return token;
  }
  private allocateCode(original: string): string {
    // Sparse Fisher-Yates: no collision retry loop near capacity, and no large
    // up-front allocation when moving from three digits to four or five.
    for (let width = 3; width <= 11; width++) {
      let pool = this.identity.codes.get(width);
      if (!pool) { pool = { remaining: 16 ** width, swaps: new Map() }; this.identity.codes.set(width, pool); }
      while (pool.remaining) {
        const index = randomInt(pool.remaining);
        const value = pool.swaps.get(index) ?? index;
        const last = --pool.remaining;
        if (index !== last) pool.swaps.set(index, pool.swaps.get(last) ?? last);
        pool.swaps.delete(last);
        const token = `PII_${value.toString(16).toUpperCase().padStart(width, '0')}`;
        if (token !== original && !this.identity.byToken.has(token) && !this.identity.byOriginal.has(token)) return token;
      }
    }
    throw new Error('Privacy token capacity exceeded.');
  }
  importIdentity(original: string, kind: string): string { return this.token(original, kind); }
  /** Share identities across the conversation, never permissions across tasks. */
  forkTask(): PrivacySession { return new PrivacySession(this.enabled, undefined, this.identity); }
  setRecipients(recipients: string[]): void { this.recipients = [...new Set(recipients)]; }
  get workspaceKey(): string { return `${this.taskId}:${this.grantRevision}`; }
  get hasGrants(): boolean { return this.grants.size > 0; }
  closeTask(): void { this.active = false; this.releaseBatch = undefined; this.sources.clear(); this.numericCounts.clear(); this.grants.clear(); this.outputs.clear(); this.resultDisplays.clear(); }
  /** Only the host semantic adapter for sanitized Python input may use this view. */
  derivedView(): PrivacySession {
    const view = new PrivacySession(this.enabled, undefined, this.identity);
    view.derived = true; view.scopeOwner = this;
    return view;
  }
  registerSource(source: IPrivacySource): void {
    if (!this.enabled || !this.active || this.sources.has(source.runId)) return;
    const bounded = { ...source, rows: source.rows.slice(0, 100) };
    const bytes = Buffer.byteLength(JSON.stringify(bounded));
    if (this.sourceBytes + bytes > 16 * 1024 * 1024) throw new Error('Privacy source budget exceeded; narrow the task.');
    this.sourceBytes += bytes;
    this.sources.set(source.runId, structuredClone(bounded));
    this.numericCounts.set(source.runId, countColumns(source.sql, source.columns));
  }
  source(runId: string): IPrivacySource | undefined { return this.sources.get(runId); }
  releaseRequest(runId: string): IPrivacyReleaseRequest {
    const source = this.sources.get(runId);
    if (!this.active || !source) throw new Error('Privacy source is not available in this task. Read or rerun the result first.');
    return { sourceRunId: runId, connectionName: source.connectionName, recipients: this.recipients, options: releaseOptions(source) };
  }
  /** Called on the completed assistant message, before sequential tool dispatch. */
  planReleaseRequests(content: readonly unknown[]): void {
    const calls: IReleaseCall[] = [];
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const call = block as Record<string, unknown>;
      if (call.type !== 'toolCall' || call.name !== 'request_column_access' || typeof call.id !== 'string' || !call.arguments || typeof call.arguments !== 'object') continue;
      const args = call.arguments as Record<string, unknown>;
      if (typeof args.runId === 'string' && typeof args.reason === 'string' && args.reason.length > 0 && args.reason.length <= 1000 && this.sources.has(args.runId)) {
        calls.push({ id: call.id, runId: args.runId, reason: args.reason });
      }
    }
    this.releaseBatch = calls.length ? { calls } : undefined;
  }
  async requestRelease(callId: string, runId: string, reason: string, ask: (request: IPrivacyReleaseRequest) => Promise<boolean | string>): Promise<boolean> {
    this.releaseRequest(runId); // Validate even when reusing a decision.
    const batch = this.releaseBatch?.calls.some(call => call.id === callId && call.runId === runId) ? this.releaseBatch : { calls: [{ id: callId, runId, reason }] };
    if (!batch.decision) {
      const calls = [...new Map(batch.calls.map(call => [call.runId, call])).values()];
      if (calls.length > 16) throw new Error('Request access to at most 16 results in one step.');
      const first = this.releaseRequest(calls[0]!.runId);
      const request: IPrivacyReleaseRequest = { ...first,
        sources: calls.map(call => ({ sourceRunId: call.runId, connectionName: this.sources.get(call.runId)?.connectionName, reason: call.reason })),
        options: calls.flatMap((call, index) => this.releaseRequest(call.runId).options.map(option => ({ ...option, id: `${index}:${option.id}`, sourceRunId: call.runId }))),
      };
      batch.decision = (async () => { this.approveRelease(request, await ask(request)); })();
    }
    await batch.decision;
    return this.active && Boolean(this.grants.get(runId)?.length);
  }
  approveRelease(request: IPrivacyReleaseRequest, answer: boolean | string): boolean {
    if (!this.active || typeof answer !== 'string' || !this.sources.has(request.sourceRunId)) return false;
    let ids: unknown;
    try { ids = JSON.parse(answer); } catch { return false; }
    if (answer.length > 20000 || !Array.isArray(ids) || !ids.length || ids.length > request.options.length || ids.some(id => typeof id !== 'string' || !request.options.some(o => o.id === id))) return false;
    const selections = request.options.filter(o => ids.includes(o.id));
    if (selections.some(o => !this.sources.has(o.sourceRunId ?? request.sourceRunId))) return false;
    for (const { column, path, sourceRunId = request.sourceRunId } of selections) {
      this.grants.set(sourceRunId, [...(this.grants.get(sourceRunId) ?? []), { column, path }]);
    }
    this.grantRevision++;
    return true;
  }
  private replaceKnown(text: string): string {
    if (this.matcherRevision !== this.identity.revision) {
      this.matcher = [{ edges: new Map() }];
      for (const [original, token] of this.identity.byOriginal) {
        if (!original) continue;
        let node = 0;
        for (const char of original) {
          let next = this.matcher[node]!.edges.get(char);
          if (next === undefined) { next = this.matcher.length; this.matcher[node]!.edges.set(char, next); this.matcher.push({ edges: new Map() }); }
          node = next;
        }
        this.matcher[node]!.token = token;
      }
      this.matcherRevision = this.identity.revision;
    }
    const chars = Array.from(text); let out = '';
    for (let i = 0; i < chars.length;) {
      let node = 0, token: string | undefined, end = i;
      for (let j = i; j < chars.length; j++) {
        const next = this.matcher[node]!.edges.get(chars[j]!); if (next === undefined) break;
        node = next;
        if (this.matcher[node]!.token) {
          const entry = this.identity.byToken.get(this.matcher[node]!.token!);
          const numeric = entry && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(entry.original);
          // Cell values like 0/1, percentages and counts are not global text
          // identities. Replacing them corrupts unrelated protocol and prose.
          if (numeric && !/^\d{7,}$/.test(entry.original)) continue;
          const startChar = chars[i]!, endChar = chars[j]!;
          const before = chars[i - 1] ?? '', after = chars[j + 1] ?? '';
          if (numeric && ((/[.,]/.test(before) && /\d/.test(chars[i - 2] ?? '')) || (/[.,]/.test(after) && /\d/.test(chars[j + 2] ?? '')))) continue;
          if (!(/[A-Za-z0-9_]/.test(startChar) && /[A-Za-z0-9_]/.test(before)) && !(/[A-Za-z0-9_]/.test(endChar) && /[A-Za-z0-9_]/.test(after))) { token = this.matcher[node]!.token; end = j + 1; }
        }
      }
      if (token) { out += token; i = end; } else out += chars[i++]!;
    }
    return out;
  }
  async maskText(text: string, _label = '', signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    if (!this.enabled || !text) return text;
    // Free prose is not a data cell: preserve instructions, mask known values
    // and cheap local contact patterns. No claim of general entity recognition.
    return text.split(new RegExp(`(${PRIVACY_TOKEN_SOURCE})`, 'g')).map((part, i) => {
      if (i % 2) return part;
      const known = this.replaceKnown(part);
      return known.split(new RegExp(`(${PRIVACY_TOKEN_SOURCE})`, 'g')).map((piece, j) => j % 2 ? piece : piece.replace(
        /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?<![\d.])(?:\+?86[- ]?)?1[3-9]\d{9}(?![\d.])/gi,
        value => this.token(value, 'contact'),
      )).join('');
    }).join('');
  }
  async maskData(value: unknown, label = '', signal?: AbortSignal, sourceRunId = '', column = -1, path: string[] = [], project = false, depth = 0): Promise<unknown> {
    signal?.throwIfAborted();
    if (!this.enabled) return value;
    if (depth > 64) throw new Error('Privacy JSON nesting limit exceeded.');
    if (secretLabel(label)) return '***redacted***';
    // Many connectors encode even COUNT results as VARCHAR. Keep their exact
    // representation, but require expression evidence and an integer value.
    if (!path.length && this.numericCounts.get(sourceRunId)?.has(column)
      && ((typeof value === 'number' && Number.isInteger(value) && value >= 0) || (typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value)))) return value;
    const selections = project && this.active ? this.grants.get(sourceRunId) ?? [] : [];
    const allowed = selectionAllows(selections, column, path);
    const parsed = parseJsonContainer(value);
    if (parsed !== value) {
      return JSON.stringify(await this.maskData(parsed, label, signal, sourceRunId, column, path, project, depth + 1));
    }
    if (Array.isArray(value)) return Promise.all(value.map(v => this.maskData(v, label, signal, sourceRunId, column, [...path, '*'], project, depth + 1)));
    if (value && typeof value === 'object') {
      const entries = await Promise.all(Object.entries(value).map(async ([key, v]) => [
        allowed || structuralKey(key) ? key : this.token(key, 'json-key'),
        await this.maskData(v, key, signal, sourceRunId, column, [...path, key], project, depth + 1),
      ] as const));
      return Object.fromEntries(entries);
    }
    if (allowed) {
      // Remember released source values too, so later tasks can mask their
      // appearances in model prose without inheriting the release authority.
      if (typeof value === 'string' && value && !this.identity.byToken.has(value)) this.token(value, 'text');
      if (typeof value === 'number' && Number.isFinite(value)) this.token(String(value), 'unknown-number');
      return redactForPrompt(value);
    }
    if (typeof value === 'string') {
      if (!value || this.identity.byToken.has(value)) return value;
      return this.token(value, 'text');
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return this.token(String(value), 'unknown-number');
    }
    return value;
  }
  async maskValue(value: unknown, label = '', signal?: AbortSignal, sourceRunId = '', project = false): Promise<unknown> {
    signal?.throwIfAborted();
    if (!this.enabled) return value;
    if (secretLabel(label)) return '***redacted***';
    if (typeof value === 'string') return this.maskText(value, label, signal);
    if (Array.isArray(value)) return Promise.all(value.map(v => this.maskValue(v, label, signal, sourceRunId, project)));
    if (value && typeof value === 'object') {
      const object = value as Record<string, unknown>;
      const ref = typeof object.runId === 'string' ? object.runId : sourceRunId;
      const out: Record<string, unknown> = {};
      for (const [key, v] of Object.entries(object)) {
        let masked: unknown;
        if ((key === 'rows' || key === 'sampleRows') && Array.isArray(v) && Array.isArray(object.columns)) {
          const columns = object.columns;
          masked = await Promise.all(v.map(row => Array.isArray(row) ? Promise.all(row.map((cell, i) => {
            const col = columns[i]; const name = typeof col === 'string' ? col : col && typeof col === 'object' && 'name' in col ? String(col.name) : '';
            return this.maskData(cell, name, signal, ref, i, [], project);
          })) : this.maskData(row, '', signal, ref, -1, [], project)));
        } else if (['columns', 'runId', 'sourceRunId', 'sourceRunIds', 'connectionName', 'alias', 'language', 'type', 'kind', 'status'].includes(key)) {
          masked = v;
        } else if (['content', 'snippet', 'excerpt', 'stdout', 'resultPreview', 'sampleValues', 'examples', 'defaultValue', 'value', 'error'].includes(key)) {
          masked = await this.maskData(v, key, signal);
        } else masked = await this.maskValue(v, key, signal, ref, project);
        Object.defineProperty(out, key, { value: masked, enumerable: true, configurable: true, writable: true });
      }
      return out;
    }
    return value;
  }
  /** Persist masked output; authorize an exact, host-owned dispatch projection. */
  async toolOutput(callId: string, name: string, text: string, signal?: AbortSignal, derived = false): Promise<string> {
    if (!this.enabled) return text;
    let value: unknown;
    try { value = JSON.parse(text); } catch { value = text; }
    const maskedValue = typeof value === 'string' ? await this.maskData(value, '', signal) : await this.maskValue(value, '', signal);
    const masked = typeof maskedValue === 'string' ? maskedValue : JSON.stringify(maskedValue);
    let projected: string;
    if (derived) projected = typeof value === 'string' ? redactForPrompt(value) : JSON.stringify(redactForPrompt(value));
    else {
      const result = await this.maskValue(value, '', signal, '', true);
      projected = typeof result === 'string' ? (typeof value === 'string' ? masked : result) : JSON.stringify(result);
      if (callId) this.resultDisplays.set(callId, this.describeResults(value, result));
    }
    if (callId && this.active && masked !== projected) {
      this.outputBytes += Buffer.byteLength(projected);
      if (this.outputBytes > 16 * 1024 * 1024) throw new Error('Privacy released-output budget exceeded; narrow the task.');
      this.outputs.set(callId, { name, masked, projected });
    }
    await this.flush(); return masked;
  }
  private describeResults(raw: unknown, projected: unknown, sourceRunId = ''): IPrivacyResultDisplay[] {
    if (!raw || !projected || typeof raw !== 'object' || typeof projected !== 'object') return [];
    if (Array.isArray(raw)) return raw.flatMap((value, i) => this.describeResults(value, (projected as unknown[])[i], sourceRunId));
    const original = raw as Record<string, unknown>, model = projected as Record<string, unknown>;
    const runId = typeof original.runId === 'string' ? original.runId : sourceRunId;
    const result: IPrivacyResultDisplay[] = [];
    if (this.sources.has(runId) && Array.isArray(original.columns)) {
      const rows = original.rows ?? original.sampleRows, safeRows = model.rows ?? model.sampleRows;
      if (Array.isArray(rows) && Array.isArray(safeRows)) {
        const columns: IPrivacyResultDisplay['columns'] = [];
        original.columns.forEach((_col, column) => {
          let masked = false, clear = false, structured = false;
          rows.forEach((row: unknown, i: number) => {
            if (!Array.isArray(row) || row[column] == null) return;
            const value: unknown = row[column], safe = safeRows[i]?.[column];
            if (JSON.stringify(value) !== JSON.stringify(safe)) masked = true;
            else clear = true;
            const parsed = parseJsonContainer(value);
            if (parsed && typeof parsed === 'object') structured = true;
          });
          const granted = this.grants.get(runId)?.some(selection => selection.column === column);
          if (masked) columns.push({ column, state: clear || structured || granted ? 'partial' : 'masked' });
          else if (granted) columns.push({ column, state: 'released' });
        });
        result.push({ runId, columns });
      }
    }
    for (const [key, child] of Object.entries(original)) if (!['rows', 'sampleRows', 'columns'].includes(key)) result.push(...this.describeResults(child, model[key], runId));
    return result;
  }
  async flush(): Promise<void> {
    this.identity.writes = this.identity.writes.then(async () => {
      if (this.identity.savedRevision === this.identity.revision) return;
      const revision = this.identity.revision;
      await this.identity.persistence?.save(structuredClone(this.state));
      this.identity.savedRevision = revision;
    });
    return this.identity.writes;
  }
  setPersistence(persistence: IPrivacyPersistence) { this.identity.persistence = persistence; }
  display(value: unknown): IPrivacyDisplay {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    const tokens = [...new Set(text.match(new RegExp(PRIVACY_TOKEN_SOURCE, 'g')) ?? [])];
    const callId = value && typeof value === 'object' && 'type' in value && value.type === 'tool_result' && 'callId' in value && typeof value.callId === 'string' ? value.callId : undefined;
    const results = callId ? this.resultDisplays.get(callId) : undefined;
    return { enabled: this.enabled, ...(results?.length ? { results } : {}), annotations: tokens.flatMap(token => {
      const e = this.identity.byToken.get(token); return e ? [{ token, original: e.original }] : [];
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
      const entry = this.identity.byToken.get(token);
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
        ? (['enum', 'const', 'default'].includes(key) ? v : await this.maskValue(redactForPrompt(v), '', signal)) : await this.maskSchema(v, signal);
    }
    return out;
  }
  /** Filter semantic text, leaving protocol names and provider signatures intact. */
  async context<T>(input: T, signal?: AbortSignal): Promise<T> {
    if (!this.enabled) {
      const restoreKnown = (v: unknown): unknown => typeof v === "string" ? v.replace(new RegExp(PRIVACY_TOKEN_SOURCE, "g"), token => this.identity.byToken.get(token)?.original ?? token) : Array.isArray(v) ? v.map(restoreKnown) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, restoreKnown(x)])) : v;
      return restoreKnown(input) as T;
    }
    if (!this.active || this.scopeOwner?.active === false) throw new Error('Privacy task has expired.');
    if (this.derived) { signal?.throwIfAborted(); return redactForPrompt(structuredClone(input)); }
    const copy = structuredClone(input) as Record<string, unknown>;
    if (typeof copy.systemPrompt === 'string') copy.systemPrompt = await this.maskText(redactForPrompt(copy.systemPrompt), 'protocol', signal);
    if (Array.isArray(copy.messages)) for (const m of copy.messages as Record<string, unknown>[]) {
      const released = m.role === 'toolResult' && typeof m.toolCallId === 'string' ? this.outputs.get(m.toolCallId) : undefined;
      if (typeof m.content === 'string') m.content = await this.maskContent(m.content, signal);
      else if (Array.isArray(m.content)) for (const block of m.content as Record<string, unknown>[]) {
        if (!['text', 'thinking', 'toolCall'].includes(String(block.type))) throw new Error('Privacy mode does not support non-text model inputs.');
        for (const key of ['text', 'thinking']) if (typeof block[key] === 'string') {
          block[key] = key === 'text' && released && released.name === m.toolName && released.masked === block[key]
            ? released.projected : await this.maskContent(block[key], signal);
        }
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
