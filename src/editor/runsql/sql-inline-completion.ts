import { completionStatus } from "@codemirror/autocomplete";
import {
  EditorSelection,
  Prec,
  StateEffect,
  StateField,
  type Extension,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  keymap,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";

import type {
  AiInlineCompletionEvent,
  AiSchemaTargetContext,
} from "@shared/types";
import type { ColumnDef } from "@/contracts";
import {
  cancelInlineCompletion,
  onInlineCompletionEvent,
  startInlineCompletion,
} from "@/services/ai";
import { useSettings } from "@/state/settings";

import { useColumnCache } from "./column-cache";
import { sqlCompletionContextBlockReason } from "./sql-inline-completion-context";
import { extractScope } from "./sql-scope";

const DEBOUNCE_MS = 250;
const MAX_PREFIX_CHARS = 4_000;
const MAX_SUFFIX_CHARS = 2_000;
const MAX_GHOST_LINES = 3;
const MAX_GHOST_CHARS = 360;
const MAX_PREWARM_TABLES = 3;
const CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX_ENTRIES = 64;

interface CompletionContext {
  pos: number;
  prefix: string;
  suffix: string;
}

interface GhostState {
  pos: number;
  text: string;
}

interface CompletionCacheEntry {
  text: string;
  expiresAt: number;
}

const completionCache = new Map<string, CompletionCacheEntry>();

function readCompletionCache(key: string): { hit: boolean; text: string } {
  const entry = completionCache.get(key);
  if (!entry) return { hit: false, text: "" };
  if (entry.expiresAt <= Date.now()) {
    completionCache.delete(key);
    return { hit: false, text: "" };
  }
  completionCache.delete(key);
  completionCache.set(key, entry);
  return { hit: true, text: entry.text };
}

function writeCompletionCache(key: string, text: string): void {
  completionCache.delete(key);
  completionCache.set(key, { text, expiresAt: Date.now() + CACHE_TTL_MS });
  while (completionCache.size > CACHE_MAX_ENTRIES) {
    const oldest = completionCache.keys().next().value as string | undefined;
    if (!oldest) break;
    completionCache.delete(oldest);
  }
}

type EventHandler = (event: AiInlineCompletionEvent) => void;

const eventHandlers = new Map<string, EventHandler>();
let eventSubscriptionReady = false;

function debug(message: string, details?: Record<string, unknown>): void {
  if (!import.meta.env.DEV) return;
  console.info("[stela][inline-completion]", message, details ?? "");
}

function ensureEventSubscription(): void {
  if (eventSubscriptionReady) return;
  eventSubscriptionReady = true;
  onInlineCompletionEvent((event) => {
    debug("received IPC event", {
      requestId: event.requestId,
      type: event.type,
      textLength: event.type === "delta" ? event.text.length : undefined,
      message: event.type === "error" ? event.message : undefined,
    });
    eventHandlers.get(event.requestId)?.(event);
    if (
      event.type === "final" ||
      event.type === "cancelled" ||
      event.type === "error"
    ) {
      eventHandlers.delete(event.requestId);
    }
  });
}

const setGhostEffect = StateEffect.define<GhostState | null>();

class InlineCompletionWidget extends WidgetType {
  constructor(private readonly text: string) {
    super();
  }

  override eq(other: InlineCompletionWidget): boolean {
    return other.text === this.text;
  }

  override toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-stela-inline-completion-ghost";
    span.textContent = this.text;
    return span;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

const ghostField = StateField.define<GhostState | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setGhostEffect)) return effect.value;
    }
    if (!value) return null;
    if (
      tr.docChanged ||
      tr.selection ||
      completionStatus(tr.state) !== null
    ) {
      return null;
    }
    return value;
  },
  provide: (field) =>
    EditorView.decorations.from(field, (value): DecorationSet => {
      if (!value) return Decoration.none;
      return Decoration.set([
        Decoration.widget({
          widget: new InlineCompletionWidget(value.text),
          side: 1,
        }).range(value.pos),
      ]);
    }),
});

function currentGhost(view: EditorView): GhostState | null {
  return view.state.field(ghostField, false) ?? null;
}

function setGhost(view: EditorView, value: GhostState | null): void {
  const current = currentGhost(view);
  if (!current && !value) return;
  if (current && value && current.pos === value.pos && current.text === value.text) {
    return;
  }
  view.dispatch({ effects: setGhostEffect.of(value) });
}

function getContext(view: EditorView): CompletionContext | null {
  const selection = view.state.selection.main;
  if (!selection.empty) return null;
  const pos = selection.head;
  const prefix = view.state.doc.sliceString(
    Math.max(0, pos - MAX_PREFIX_CHARS),
    pos,
  );
  const suffix = view.state.doc.sliceString(
    pos,
    Math.min(view.state.doc.length, pos + MAX_SUFFIX_CHARS),
  );
  if (`${prefix}${suffix}`.replace(/\s/g, "").length < 3) return null;
  return {
    pos,
    prefix,
    suffix,
  };
}

function getContextBlockReason(
  view: EditorView,
  allowCompleteStatement = false,
): string | null {
  const selection = view.state.selection.main;
  if (!selection.empty) return "selection is not empty";
  return sqlCompletionContextBlockReason(view.state, selection.head, {
    allowCompleteStatement,
  });
}

function stripRepeatedPrefix(text: string, prefix: string): string {
  if (text.startsWith(prefix)) return text.slice(prefix.length);
  const currentLine = prefix.slice(prefix.lastIndexOf("\n") + 1);
  if (currentLine.trim().length >= 3 && text.startsWith(currentLine)) {
    return text.slice(currentLine.length);
  }
  const max = Math.min(text.length, prefix.length, 500);
  for (let length = max; length >= 8; length -= 1) {
    if (text.startsWith(prefix.slice(-length))) return text.slice(length);
  }
  return text;
}

const SQL_KEYWORDS = new Set(
  "select from where join left right inner outer cross on using group by having order limit offset union all and or as case when then else end with insert update delete into values set".split(
    " ",
  ),
);

function addRequiredLeadingSpace(text: string, prefix: string, suffix: string): string {
  if (!text || /^\s/.test(text)) return text;
  const beforeCursor = prefix.at(-1);
  const firstSuggestionChar = text[0];
  if (
    !beforeCursor ||
    !/[\p{L}\p{N}_\])]/u.test(beforeCursor) ||
    !/[\p{L}\p{N}_$`"'[*]/u.test(firstSuggestionChar)
  ) {
    return text;
  }
  // True middle-of-token FIM: `sel|ect` must insert `ect`, not ` ect`.
  if (/^[\p{L}\p{N}_$]/u.test(suffix)) return text;
  const partial = /[\p{L}_]+$/u.exec(prefix)?.[0]?.toLowerCase() ?? "";
  const firstWord = /^[\p{L}_]+/u.exec(text)?.[0]?.toLowerCase() ?? "";
  if (
    partial &&
    firstWord &&
    !SQL_KEYWORDS.has(partial) &&
    SQL_KEYWORDS.has(`${partial}${firstWord}`)
  ) {
    return text;
  }
  return ` ${text}`;
}

export function normalizeSuggestion(
  text: string,
  prefix: string,
  suffix: string,
  final: boolean,
): string {
  let out = text.replace(/\r\n?/g, "\n");
  const trimmed = out.trim();
  if (
    !final &&
    ("```sql".startsWith(trimmed.toLowerCase()) ||
      (trimmed.startsWith("```") && !trimmed.includes("\n")))
  ) {
    return "";
  }
  if (/^```(?:sql)?(?:\s*\n|$)/i.test(trimmed)) {
    const fenced = /^```(?:sql)?\s*\n([\s\S]*?)(?:\n```)\s*$/i.exec(trimmed);
    if (!fenced && !final) return "";
    out =
      fenced?.[1] ??
      trimmed
        .replace(/^```(?:sql)?\s*\n?/i, "")
        .replace(/\n?```\s*$/i, "");
  }

  if (!final && out && prefix.endsWith(out)) return "";
  out = stripRepeatedPrefix(out, prefix);
  const maxOverlap = Math.min(out.length, suffix.length);
  for (let length = maxOverlap; length > 0; length -= 1) {
    if (out.endsWith(suffix.slice(0, length))) {
      out = out.slice(0, -length);
      break;
    }
  }
  out = addRequiredLeadingSpace(out, prefix, suffix);
  out = out.split("\n").slice(0, MAX_GHOST_LINES).join("\n");
  return out.slice(0, MAX_GHOST_CHARS);
}

function acceptCompletion(view: EditorView): boolean {
  const ghost = currentGhost(view);
  if (!ghost) return false;
  view.dispatch({
    changes: { from: ghost.pos, insert: ghost.text },
    selection: EditorSelection.cursor(ghost.pos + ghost.text.length),
    effects: setGhostEffect.of(null),
  });
  debug("suggestion accepted", { chars: ghost.text.length });
  return true;
}

/**
 * 光标所在语句 FROM/JOIN 段里的表，取列缓存中**已就绪**的那些。
 *
 * 只读缓存不触发探针：探针有 100~300ms 往返，加在补全请求前面就直接变成
 * 首 token 延迟。预热由 block 获得焦点时的 fire-and-forget 负责（B1），
 * 到用户真的敲到 SELECT 时缓存通常已经热了。
 */
function cachedTableSchemas(
  view: EditorView,
  connectionName: string | null,
): AiSchemaTargetContext[] {
  if (!connectionName) return [];
  const cache = useColumnCache.getState();
  const out: AiSchemaTargetContext[] = [];
  for (const path of extractScope(view.state, view.state.selection.main.head).tables) {
    if (path.length === 0) continue;
    const table = path[path.length - 1];
    const database = path.length > 1 ? path[path.length - 2] : null;
    const status = cache.getStatus(connectionName, database, table);
    if (status.kind !== "ready" || status.columns.length === 0) continue;
    out.push({
      database,
      table,
      columns: status.columns.map((column) => ({
        name: column.name,
        typeName: column.typeName,
      })),
    });
  }
  return out.slice(0, MAX_PREWARM_TABLES);
}

export function sqlInlineCompletionExtension({
  getConnectionName,
  getSiblingSqls,
  getNoteContext,
  ensureColumnsForTable,
  canRequest,
}: {
  getConnectionName: () => string | null;
  getSiblingSqls: () => string[];
  /** 当前块所在小节的 heading 与一段散文，口径说明常写在那里。 */
  getNoteContext?: () => { heading: string | null; prose: string | null };
  /** Existing column-cache-backed probe; awaited before a paid model request. */
  ensureColumnsForTable?: (
    db: string | null,
    table: string,
  ) => Promise<ColumnDef[]>;
  canRequest: () => boolean;
}): Extension {
  ensureEventSubscription();

  const plugin = ViewPlugin.fromClass(
    class {
      private timeout: ReturnType<typeof setTimeout> | null = null;
      private requestId: string | null = null;
      private composing = false;
      private inputDuringComposition = false;
      private pendingEdit = false;
      private rawText = "";
      private context: CompletionContext | null = null;
      private scheduledAt = 0;
      private performanceLogged = false;
      private activeCacheKey: string | null = null;
      private allowCompleteStatement = false;
      private readonly settingsUnsubscribe: () => void;

      constructor(private readonly view: EditorView) {
        this.settingsUnsubscribe = useSettings.subscribe(() => {
          if (!this.canStart()) this.reset();
        });
      }

      update(update: ViewUpdate): void {
        if (update.docChanged) {
          debug("document change observed", {
            composing: this.composing,
            selectionEmpty: update.state.selection.main.empty,
          });
          if (this.composing) {
            this.inputDuringComposition = true;
            this.reset();
          } else {
            this.pendingEdit = true;
            this.schedule();
          }
          return;
        }
        if (update.selectionSet) {
          this.pendingEdit = false;
          this.reset();
          return;
        }
        const before = completionStatus(update.startState);
        const after = completionStatus(update.state);
        if (before === after) return;
        if (after !== null) {
          this.reset();
        } else if (this.pendingEdit) {
          debug("native completion popup closed; rescheduling pending edit");
          this.schedule();
        }
      }

      destroy(): void {
        this.settingsUnsubscribe();
        this.reset();
      }

      blur(): void {
        this.reset();
      }

      compositionStart(): void {
        this.composing = true;
        this.inputDuringComposition = false;
        this.reset();
      }

      compositionEnd(): void {
        this.composing = false;
        if (this.inputDuringComposition) {
          this.inputDuringComposition = false;
          this.pendingEdit = true;
          this.schedule();
        }
      }

      clearGhost(): boolean {
        const ghost = currentGhost(this.view);
        const hadActivity =
          ghost !== null || this.requestId !== null || this.timeout !== null;
        if (ghost) debug("suggestion rejected", { chars: ghost.text.length });
        if (hadActivity) this.reset();
        return hadActivity;
      }

      requestManual(): boolean {
        this.pendingEdit = false;
        this.reset();
        const blockReason = this.getStartBlockReason(true);
        if (blockReason) {
          debug("manual request blocked", { reason: blockReason });
          return false;
        }
        this.scheduledAt = performance.now();
        void this.request(true);
        return true;
      }

      private canStart(): boolean {
        return this.getStartBlockReason(this.allowCompleteStatement) === null;
      }

      private getStartBlockReason(allowCompleteStatement = false): string | null {
        const ai = useSettings.getState().settings.ai;
        const profile = ai.profiles.find(
          (item) => item.id === ai.completionProfileId,
        );
        if (ai.providerMode === "disabled") return "AI provider is disabled";
        if (!ai.inlineCompletionEnabled) return "inline completion is disabled";
        if (!profile) return "completion profile is missing";
        if (!profile.hasApiKey) return "completion profile has no API key";
        if (this.composing) return "IME composition is active";
        if (!this.view.hasFocus) return "editor is not focused";
        if (completionStatus(this.view.state) !== null) {
          return "native completion popup is open";
        }
        if (!canRequest()) return "another RunSQL AI operation is pending";
        return getContextBlockReason(this.view, allowCompleteStatement);
      }

      private schedule(): void {
        this.reset();
        this.scheduledAt = performance.now();
        const blockReason = this.getStartBlockReason();
        if (blockReason) {
          debug("request not scheduled", { reason: blockReason });
          return;
        }
        debug("request scheduled", { debounceMs: DEBOUNCE_MS });
        this.timeout = setTimeout(() => {
          this.timeout = null;
          void this.request();
        }, DEBOUNCE_MS);
      }

      private reset(): void {
        if (this.timeout) {
          clearTimeout(this.timeout);
          this.timeout = null;
        }
        setGhost(this.view, null);
        if (this.requestId) {
          const requestId = this.requestId;
          this.requestId = null;
          eventHandlers.delete(requestId);
          void cancelInlineCompletion(requestId).catch(() => {});
        }
        this.context = null;
        this.rawText = "";
        this.activeCacheKey = null;
        this.allowCompleteStatement = false;
      }

      private async request(allowCompleteStatement = false): Promise<void> {
        this.allowCompleteStatement = allowCompleteStatement;
        const blockReason = this.getStartBlockReason(allowCompleteStatement);
        if (blockReason) {
          debug("request cancelled before IPC", { reason: blockReason });
          this.reset();
          return;
        }
        const context = getContext(this.view);
        if (!context) return;
        const stateBeforeSchema = this.view.state;
        const ai = useSettings.getState().settings.ai;
        const profile = ai.profiles.find((item) => item.id === ai.completionProfileId);
        if (!profile) return;
        const connectionName = getConnectionName();
        if (connectionName && ensureColumnsForTable) {
          const targets = extractScope(stateBeforeSchema, context.pos).tables
            .filter((path) => path.length > 0)
            .slice(0, MAX_PREWARM_TABLES);
          await Promise.all(
            targets.map((path) => {
              const table = path[path.length - 1];
              const database = path.length > 1 ? path[path.length - 2] : null;
              return ensureColumnsForTable(database, table);
            }),
          );
          const current = getContext(this.view);
          if (
            this.view.state !== stateBeforeSchema ||
            !current ||
            current.pos !== context.pos ||
            current.prefix !== context.prefix ||
            current.suffix !== context.suffix
          ) {
            debug("request cancelled after schema warmup", { reason: "context changed" });
            return;
          }
          const reasonAfterSchema = this.getStartBlockReason(allowCompleteStatement);
          if (reasonAfterSchema) {
            debug("request cancelled after schema warmup", { reason: reasonAfterSchema });
            return;
          }
        }
        const tableSchemas = cachedTableSchemas(this.view, connectionName);
        const noteContext = getNoteContext?.();
        const siblingSqls = getSiblingSqls();
        const cacheKey = JSON.stringify({
          profileId: profile.id,
          model: profile.model,
          connectionName,
          prefix: context.prefix,
          suffix: context.suffix,
          tableSchemas,
          heading: noteContext?.heading ?? null,
          prose: noteContext?.prose ?? null,
          siblingSqls,
        });
        const cached = readCompletionCache(cacheKey);
        if (cached.hit) {
          this.context = context;
          this.rawText = cached.text;
          this.pendingEdit = false;
          debug("completion cache hit", { chars: cached.text.length });
          this.showNormalized(true);
          return;
        }
        const requestId = crypto.randomUUID();
        this.requestId = requestId;
        this.context = context;
        this.rawText = "";
        this.pendingEdit = false;
        this.performanceLogged = false;
        this.activeCacheKey = cacheKey;
        eventHandlers.set(requestId, (event) => this.onEvent(event));
        try {
          debug("starting IPC request", {
            requestId,
            prefixLength: context.prefix.length,
            suffixLength: context.suffix.length,
            cachedTables: tableSchemas.length,
          });
          await startInlineCompletion({
            requestId,
            prefix: context.prefix,
            suffix: context.suffix,
            siblingSqls,
            connectionName,
            tableSchemas,
            heading: noteContext?.heading ?? null,
            prose: noteContext?.prose ?? null,
          });
        } catch (err) {
          debug("IPC request failed", {
            requestId,
            error: err instanceof Error ? err.message : String(err),
          });
          if (this.requestId === requestId) this.reset();
        }
      }

      private onEvent(event: AiInlineCompletionEvent): void {
        if (event.requestId !== this.requestId || !this.context) {
          debug("ignored stale completion event", {
            requestId: event.requestId,
            activeRequestId: this.requestId,
            type: event.type,
          });
          return;
        }
        if (event.type === "delta") {
          this.rawText += event.text;
          this.showNormalized(false);
          return;
        }
        if (event.type === "final") {
          this.showNormalized(true);
          if (this.activeCacheKey) writeCompletionCache(this.activeCacheKey, this.rawText);
          this.requestId = null;
          this.context = null;
          this.rawText = "";
          this.activeCacheKey = null;
          this.allowCompleteStatement = false;
          return;
        }
        if (event.type === "cancelled" || event.type === "error") {
          this.requestId = null;
          this.context = null;
          this.rawText = "";
          this.activeCacheKey = null;
          this.allowCompleteStatement = false;
          setGhost(this.view, null);
        }
      }

      private showNormalized(final: boolean): void {
        const context = this.context;
        if (!context || !this.canStart()) {
          this.reset();
          return;
        }
        const current = getContext(this.view);
        if (
          !current ||
          current.pos !== context.pos ||
          current.prefix !== context.prefix ||
          current.suffix !== context.suffix
        ) {
          this.reset();
          return;
        }
        const text = normalizeSuggestion(
          this.rawText,
          context.prefix,
          context.suffix,
          final,
        );
        if (!text.trim()) {
          debug("suggestion is empty after normalization", {
            final,
            rawTextLength: this.rawText.length,
          });
          setGhost(this.view, null);
          return;
        }
        setGhost(this.view, { pos: context.pos, text });
        if (import.meta.env.DEV && !this.performanceLogged) {
          this.performanceLogged = true;
          console.debug(
            `[stela] inline completion visible in ${(performance.now() - this.scheduledAt).toFixed(1)}ms`,
          );
        }
      }
    },
    {
      eventHandlers: {
        compositionstart(_event, view) {
          view.plugin(plugin)?.compositionStart();
        },
        compositionend(_event, view) {
          view.plugin(plugin)?.compositionEnd();
        },
        blur(_event, view) {
          view.plugin(plugin)?.blur();
        },
      },
    },
  );

  return [
    ghostField,
    plugin,
    Prec.highest(
      keymap.of([
        { key: "Tab", run: acceptCompletion },
        {
          key: "Alt-\\",
          run: (view) => view.plugin(plugin)?.requestManual() ?? false,
        },
        {
          key: "Escape",
          run: (view) => view.plugin(plugin)?.clearGhost() ?? false,
        },
      ]),
    ),
  ];
}
