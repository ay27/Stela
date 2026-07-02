import { completionStatus } from "@codemirror/autocomplete";
import {
  EditorSelection,
  Prec,
  StateEffect,
  StateField,
  type Extension,
  type SelectionRange,
  type TransactionSpec,
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

import { completeAiFim } from "@/services/ai";
import { useSettings } from "@/state/settings";

/** Feature flag — flip to true when FIM quality is ready to ship. */
export const SQL_FIM_ENABLED = false;

const FIM_DEBOUNCE_MS = 400;
const MAX_FIM_CONTEXT_CHARS = 8_000;
const MIN_PREFIX_CHARS = 3;
const MAX_GHOST_LINES = 8;
const MAX_GHOST_CHARS = 800;

interface FimContext {
  pos: number;
  prompt: string;
  suffix: string;
}

export interface GhostState {
  pos: number;
  text: string;
}

const setGhostEffect = StateEffect.define<GhostState | null>();

class GhostTextWidget extends WidgetType {
  constructor(private readonly text: string) {
    super();
  }

  override eq(other: GhostTextWidget): boolean {
    return other.text === this.text;
  }

  override toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-stela-fim-ghost";
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
    if (!value) return value;
    if (tr.docChanged) return null;
    if (tr.selection && shouldClearGhostForSelection(value, tr.selection.main)) {
      return null;
    }
    return value;
  },
  provide: (field) =>
    EditorView.decorations.from(field, (value): DecorationSet => {
      if (!value) return Decoration.none;
      return Decoration.set([
        Decoration.widget({
          widget: new GhostTextWidget(value.text),
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

export function getFimContext(state: EditorView["state"]): FimContext | null {
  const selection = state.selection.main;
  if (!selection.empty) return null;
  const pos = selection.head;
  const prefixStart = Math.max(0, pos - MAX_FIM_CONTEXT_CHARS);
  const suffixEnd = Math.min(state.doc.length, pos + MAX_FIM_CONTEXT_CHARS);
  const prompt = state.doc.sliceString(prefixStart, pos);
  const suffix = state.doc.sliceString(pos, suffixEnd);
  if (prompt.trim().length < MIN_PREFIX_CHARS) return null;
  return { pos, prompt, suffix };
}

export function acceptFimCompletion(view: EditorView): boolean {
  const ghost = currentGhost(view);
  if (!ghost) return false;
  view.dispatch(createFimAcceptSpec(ghost));
  return true;
}

export function createFimAcceptSpec(ghost: GhostState): TransactionSpec {
  return {
    changes: { from: ghost.pos, insert: ghost.text },
    selection: EditorSelection.cursor(ghost.pos + ghost.text.length),
    effects: setGhostEffect.of(null),
  };
}

export function shouldClearGhostForSelection(
  ghost: GhostState | null,
  selection: SelectionRange,
): boolean {
  return !!ghost && (!selection.empty || selection.head !== ghost.pos);
}

export function normalizeFimSuggestion(text: string, suffix: string): string {
  let out = text.replace(/\r\n?/g, "\n");
  const fenceMatch = /^```(?:sql)?\s*\n([\s\S]*?)\n```$/i.exec(out.trim());
  if (fenceMatch) out = fenceMatch[1] ?? "";
  const maxOverlap = Math.min(out.length, suffix.length);
  for (let len = maxOverlap; len > 0; len -= 1) {
    if (out.endsWith(suffix.slice(0, len))) {
      out = out.slice(0, -len);
      break;
    }
  }
  const lines = out.split("\n");
  if (lines.length > MAX_GHOST_LINES) {
    out = lines.slice(0, MAX_GHOST_LINES).join("\n");
  }
  if (out.length > MAX_GHOST_CHARS) {
    out = out.slice(0, MAX_GHOST_CHARS);
  }
  return out;
}

function canRequestFim(view: EditorView, composing: boolean): boolean {
  const ai = useSettings.getState().settings.ai;
  return (
    ai.providerMode !== "disabled" &&
    ai.hasApiKey &&
    ai.inlineCompletionEnabled &&
    !composing &&
    completionStatus(view.state) === null &&
    getFimContext(view.state) !== null
  );
}

export function sqlFimCompletionExtension(
  getConnectionName: () => string | null,
): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      private timeout: ReturnType<typeof setTimeout> | null = null;
      private requestId = 0;
      private composing = false;

      constructor(private readonly view: EditorView) {
        this.schedule();
      }

      update(update: ViewUpdate): void {
        if (update.docChanged) {
          this.schedule();
          return;
        }
        if (update.selectionSet) {
          const ghost = update.startState.field(ghostField, false) ?? null;
          const selection = update.state.selection.main;
          if (!ghost || !selection.empty || selection.head !== ghost.pos) {
            this.schedule();
          }
        }
      }

      destroy(): void {
        this.clearTimer();
        this.requestId += 1;
      }

      compositionStart(): void {
        this.composing = true;
        setGhost(this.view, null);
        this.clearTimer();
      }

      compositionEnd(): void {
        this.composing = false;
        this.schedule();
      }

      private schedule(): void {
        this.clearTimer();
        if (!canRequestFim(this.view, this.composing)) return;
        const id = ++this.requestId;
        this.timeout = setTimeout(() => {
          void this.request(id);
        }, FIM_DEBOUNCE_MS);
      }

      private clearTimer(): void {
        if (this.timeout) {
          clearTimeout(this.timeout);
          this.timeout = null;
        }
      }

      private async request(id: number): Promise<void> {
        this.timeout = null;
        const ctx = getFimContext(this.view.state);
        if (!ctx || !canRequestFim(this.view, this.composing)) return;
        try {
          const response = await completeAiFim({
            prompt: ctx.prompt,
            suffix: ctx.suffix,
            connectionName: getConnectionName(),
          });
          if (id !== this.requestId) return;
          const current = getFimContext(this.view.state);
          if (
            !current ||
            current.pos !== ctx.pos ||
            current.prompt !== ctx.prompt ||
            current.suffix !== ctx.suffix
          ) {
            return;
          }
          const text = normalizeFimSuggestion(response.text, ctx.suffix);
          if (text.trim().length === 0) return;
          setGhost(this.view, { pos: ctx.pos, text });
        } catch {
          if (id === this.requestId) setGhost(this.view, null);
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
      },
    },
  );

  return [
    ghostField,
    plugin,
    Prec.highest(
      keymap.of([
        {
          key: "Tab",
          run: acceptFimCompletion,
        },
        {
          key: "Escape",
          run: (view) => {
            if (!currentGhost(view)) return false;
            setGhost(view, null);
            return true;
          },
        },
      ]),
    ),
  ];
}
