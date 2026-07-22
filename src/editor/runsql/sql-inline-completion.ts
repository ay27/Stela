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

import type { AiInlineCompletionEvent } from "@shared/types";
import {
  cancelInlineCompletion,
  onInlineCompletionEvent,
  startInlineCompletion,
} from "@/services/ai";
import { useSettings } from "@/state/settings";

const DEBOUNCE_MS = 120;
const MAX_PREFIX_CHARS = 12_000;
const MAX_SUFFIX_CHARS = 8_000;
const MAX_GHOST_LINES = 1;
const MAX_GHOST_CHARS = 240;

interface CompletionContext {
  pos: number;
  prefix: string;
  suffix: string;
}

interface GhostState {
  pos: number;
  text: string;
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
  const line = view.state.doc.lineAt(pos);
  if (view.state.doc.sliceString(pos, line.to).trim()) return null;
  const prefix = view.state.doc.sliceString(
    Math.max(0, pos - MAX_PREFIX_CHARS),
    pos,
  );
  if (prefix.replace(/\s/g, "").length < 3) return null;
  return {
    pos,
    prefix,
    suffix: view.state.doc.sliceString(
      pos,
      Math.min(view.state.doc.length, pos + MAX_SUFFIX_CHARS),
    ),
  };
}

function getContextBlockReason(view: EditorView): string | null {
  const selection = view.state.selection.main;
  if (!selection.empty) return "selection is not empty";
  const line = view.state.doc.lineAt(selection.head);
  if (view.state.doc.sliceString(selection.head, line.to).trim()) {
    return "cursor is not at line end";
  }
  const prefix = view.state.doc.sliceString(
    Math.max(0, selection.head - MAX_PREFIX_CHARS),
    selection.head,
  );
  return prefix.replace(/\s/g, "").length < 3 ? "SQL prefix is too short" : null;
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

function addRequiredLeadingSpace(text: string, prefix: string): string {
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
  return ` ${text}`;
}

function normalizeSuggestion(
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
  out = addRequiredLeadingSpace(out, prefix);
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
  return true;
}

export function sqlInlineCompletionExtension({
  getConnectionName,
  getSiblingSqls,
  canRequest,
}: {
  getConnectionName: () => string | null;
  getSiblingSqls: () => string[];
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
        const hadActivity =
          currentGhost(this.view) !== null ||
          this.requestId !== null ||
          this.timeout !== null;
        if (hadActivity) this.reset();
        return hadActivity;
      }

      private canStart(): boolean {
        return this.getStartBlockReason() === null;
      }

      private getStartBlockReason(): string | null {
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
        return getContextBlockReason(this.view);
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
      }

      private async request(): Promise<void> {
        const blockReason = this.getStartBlockReason();
        if (blockReason) {
          debug("request cancelled before IPC", { reason: blockReason });
          this.reset();
          return;
        }
        const context = getContext(this.view);
        if (!context) return;
        const requestId = crypto.randomUUID();
        this.requestId = requestId;
        this.context = context;
        this.rawText = "";
        this.pendingEdit = false;
        this.performanceLogged = false;
        eventHandlers.set(requestId, (event) => this.onEvent(event));
        try {
          debug("starting IPC request", {
            requestId,
            prefixLength: context.prefix.length,
            suffixLength: context.suffix.length,
          });
          await startInlineCompletion({
            requestId,
            prefix: context.prefix,
            suffix: context.suffix,
            siblingSqls: getSiblingSqls(),
            connectionName: getConnectionName(),
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
          this.requestId = null;
          this.context = null;
          this.rawText = "";
          return;
        }
        if (event.type === "cancelled" || event.type === "error") {
          this.requestId = null;
          this.context = null;
          this.rawText = "";
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
          key: "Escape",
          run: (view) => view.plugin(plugin)?.clearGhost() ?? false,
        },
      ]),
    ),
  ];
}
