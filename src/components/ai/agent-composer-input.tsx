import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Compartment, EditorState, Prec, StateField } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, keymap, placeholder, drawSelection, type DecorationSet } from "@codemirror/view";
import { defaultKeymap, historyKeymap, indentWithTab, isolateHistory } from "@codemirror/commands";
import { autocompletion, acceptCompletion, closeCompletion, completionStatus, completionKeymap, CompletionContext, startCompletion, type Completion } from "@codemirror/autocomplete";
import { syntaxTree, ensureSyntaxTree } from "@codemirror/language";
import { createComposerSqlField } from "@/lib/composer-sql-state";
import { highlightTree, classHighlighter } from "@lezer/highlight";
import { AtSign, Braces } from "lucide-react";
import type { AgentMessageContent, AgentMessageResource } from "@shared/types";
import { configureAgentComposerState, agentComposerClipboardText, agentComposerStateToMessage, agentResourceDisplay, composerResources, insertAgentComposerResourceTransaction, isAgentComposerEmpty } from "@/lib/agent-composer";
import { formatComposerSql } from "@/lib/composer-sql";
import { createSqlCompletionSource } from "@/editor/runsql/sql-language";
import { ensureAutocompleteFor } from "@/editor/runsql/fetch-schema";
import { useColumnCache } from "@/editor/runsql/column-cache";
import { resolveEditorDialect } from "@/services/connectors/registry";
import { composerResourceCandidates, composerRunsqlCandidates } from "@/services/composer-resources";
import { useT } from "@/i18n/use-t";
import "./agent-composer-input.css";

const ui = new Compartment();
export interface AgentComposerInputHandle { focus: () => void }
export interface AgentComposerInputProps {
  state: EditorState;
  disabled?: boolean;
  submitEnabled?: boolean;
  connectionName?: string | null;
  siblingSqls?: string[];
  placeholder?: string;
  className?: string;
  getResourceCandidates?: (query: string) => Promise<AgentMessageResource[]>;
  onChange?: (state: EditorState, isEmpty: boolean) => void;
  onSubmit?: (message: AgentMessageContent) => void;
  onOpenResource?: (resource: AgentMessageResource) => void;
  renderActions?: (tools: ReactNode) => ReactNode;
}
class ResourceWidget extends WidgetType {
  constructor(readonly resource: AgentMessageResource, readonly open?: (r: AgentMessageResource) => void) { super(); }
  eq(other: ResourceWidget) { return this.resource === other.resource && this.open === other.open; }
  toDOM() {
    const element = document.createElement("button"); element.type = "button"; element.tabIndex = -1;
    element.className = "stela-agent-resource-pill";
    element.textContent = agentResourceDisplay(this.resource);
    element.title = "path" in this.resource ? this.resource.path : this.resource.label;
    element.addEventListener("mousedown", e => e.preventDefault());
    element.addEventListener("click", () => this.open?.(this.resource));
    return element;
  }
  ignoreEvent() { return true; }
}
export const AgentComposerInput = forwardRef<AgentComposerInputHandle, AgentComposerInputProps>(function AgentComposerInput(props, ref) {
  const t = useT();
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView>();
  const publishedState = useRef(props.state);
  const latest = useRef(props); latest.current = props;
  const [hint, setHint] = useState("");
  const scope = useRef<{ path: string; from: number; query: string } | null>(null);
  useImperativeHandle(ref, () => ({ focus: () => editor.current?.focus() }), []);
  const format = () => {
    const view = editor.current;
    if (!view || latest.current.disabled) return false;
    const { from, to } = view.state.selection.main;
    const result = formatComposerSql(view.state.doc.toString(), from, to, resolveEditorDialect(latest.current.connectionName ?? null));
    if (!result) { setHint(t("agent.composer.selectSql")); return true; }
    setHint("");
    view.dispatch({ changes: { from: result.from, to: result.to, insert: result.text }, selection: { anchor: result.from + result.text.length }, userEvent: "input.format", annotations: isolateHistory.of("full") });
    view.focus(); return true;
  };
  const extensions = () => {
    const name = latest.current.connectionName ?? null;
    const dialect = resolveEditorDialect(name);
    const sqlRegions = createComposerSqlField(dialect);
    const sqlSource = createSqlCompletionSource({ dialect, getSiblingSqls: () => latest.current.siblingSqls ?? [],
      getTableNames: () => name ? ensureAutocompleteFor(name) : Promise.resolve([]),
      ensureColumnsForTable: (db, table) => name ? useColumnCache.getState().ensure(name, db, table) : Promise.resolve([]),
    });
    const resources = StateField.define<DecorationSet>({
      create: state => decorateResources(state), update: (value, tr) => tr.docChanged || tr.startState.field(composerResources) !== tr.state.field(composerResources) ? decorateResources(tr.state) : value,
      provide: field => [EditorView.decorations.from(field), EditorView.atomicRanges.of(view => view.state.field(field))],
    });
    function decorateResources(state: EditorState) {
      return Decoration.set(state.field(composerResources).map(item => Decoration.replace({ widget: new ResourceWidget(item.resource, latest.current.onOpenResource) }).range(item.from, item.from + 1)), true);
    }
    const colors = StateField.define<DecorationSet>({
      create: state => colorSql(state), update: (value, tr) => tr.docChanged ? colorSql(tr.state) : value,
      provide: field => EditorView.decorations.from(field),
    });
    function colorSql(state: EditorState) {
      const ranges = [];
      for (const region of state.field(sqlRegions)) {
        if (region.from >= region.to) continue;
        ranges.push(Decoration.mark({ class: "stela-composer-sql" }).range(region.from, region.to));
        highlightTree(ensureSyntaxTree(region.state, region.state.doc.length, 10) ?? syntaxTree(region.state), classHighlighter, (from, to, classes) => {
          ranges.push(Decoration.mark({ class: classes }).range(region.from + from, region.from + to));
        });
      }
      return Decoration.set(ranges, true);
    }
    return [sqlRegions, resources, colors, EditorView.editable.of(!latest.current.disabled),
      placeholder(latest.current.placeholder ?? ""), EditorView.lineWrapping,
      drawSelection({ cursorBlinkRate: 1200 }),
      autocompletion({ defaultKeymap: false, aboveCursor: true, override: [async ctx => {
        const before = ctx.state.sliceDoc(0, ctx.pos);
        const mention = /(?:^|\s)@([^@\n\uFFFC]*)$/.exec(before);
        const region = ctx.state.field(sqlRegions).find(r => r.from <= ctx.pos && r.to >= ctx.pos);
        if (mention && !region) {
          const query = mention[1], from = ctx.pos - query.length - 1;
          if (scope.current && (scope.current.from !== from || scope.current.query !== query)) scope.current = null;
          try {
            const candidates = scope.current ? await composerRunsqlCandidates(scope.current.path)
              : await (latest.current.getResourceCandidates?.(query) ?? composerResourceCandidates(query, name));
            if (ctx.aborted || name !== (latest.current.connectionName ?? null)) return null;
            const options: Completion[] = [];
            for (const resource of candidates) {
              options.push({ label: resource.label, detail: "path" in resource ? resource.path : resource.kind, type: resource.kind === "table" ? "class" : "text", apply: (view, _item, a, b) => {
                view.dispatch(insertAgentComposerResourceTransaction(view.state, resource, { from: a, to: b, trailingSpaceAtEnd: true })); scope.current = null;
              } });
              if (!scope.current && resource.kind === "note") options.push({ label: `${resource.label} › SQL`, detail: t("agent.composer.blocks"), type: "namespace", apply: view => {
                scope.current = { path: resource.path, from, query }; closeCompletion(view); startCompletion(view);
              } });
            }
            setHint(options.length ? "" : t("agent.composer.noReferences"));
            return { from, options, filter: false };
          } catch { if (!ctx.aborted) setHint(t("agent.composer.referencesFailed")); return null; }
        }
        scope.current = null;
        if (!region) return null;
        const state = region.state, pos = ctx.pos - region.from;
        const parsed = ensureSyntaxTree(state, pos, 10) ?? syntaxTree(state);
        const node = parsed.resolveInner(Math.max(0, pos - 1), -1);
        if (/String|Comment|QuotedIdentifier/.test(node.name)) return null;
        const result = await sqlSource(new CompletionContext(state, pos, ctx.explicit));
        if (ctx.aborted || name !== (latest.current.connectionName ?? null) || !result) return null;
        return { ...result, from: result.from + region.from, to: result.to === undefined ? undefined : result.to + region.from };
      }] }),
      Prec.highest(keymap.of([
        { key: "Mod-Enter", run: view => {
          if (view.composing) return false;
          if (completionStatus(view.state)) { scope.current = null; closeCompletion(view); return true; }
          if (latest.current.submitEnabled && !latest.current.disabled && !isAgentComposerEmpty(view.state)) latest.current.onSubmit?.(agentComposerStateToMessage(view.state));
          return true;
        } },
        { key: "Mod-Alt-l", run: format },
        { key: "Escape", run: view => { scope.current = null; return closeCompletion(view); } },
        { key: "Tab", run: view => acceptCompletion(view) },
        ...completionKeymap,
      ])),
      keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
      EditorView.domEventHandlers({
        copy: (event, view) => {
          if (view.state.selection.main.empty || !event.clipboardData) return false;
          const { from, to } = view.state.selection.main;
          event.clipboardData.setData("text/plain", agentComposerClipboardText(view.state, from, to)); event.preventDefault(); return true;
        },
        cut: (event, view) => {
          if (latest.current.disabled || view.state.selection.main.empty || !event.clipboardData) return false;
          const { from, to } = view.state.selection.main;
          event.clipboardData.setData("text/plain", agentComposerClipboardText(view.state, from, to)); event.preventDefault();
          view.dispatch({ changes: { from, to }, selection: { anchor: from }, userEvent: "delete.cut" }); return true;
        },
      }),
      EditorView.updateListener.of(update => {
        if (update.docChanged) setHint("");
        if (update.docChanged || update.selectionSet) {
          const model = configureAgentComposerState(update.state);
          publishedState.current = model;
          latest.current.onChange?.(model, isAgentComposerEmpty(model));
        }
      }),
      EditorView.theme({ "&": { backgroundColor: "transparent", fontSize: "13px" }, "&.cm-focused": { outline: "none" },
        ".cm-scroller": { minHeight: "84px", maxHeight: "min(280px, 33vh)", overflow: "auto", fontFamily: "inherit" },
        ".cm-content": { minHeight: "84px", padding: "2px 0" }, ".cm-line": { padding: "0", lineHeight: "1.65" },
        ".cm-cursor": { borderLeftColor: "hsl(var(--foreground))", borderLeftWidth: "2px" },
        "&.cm-focused .cm-selectionBackground": { backgroundColor: "hsl(var(--primary) / .18)" },
        ".cm-placeholder": { color: "hsl(var(--muted-foreground) / .65)" },
        ".cm-tooltip": { border: "1px solid hsl(var(--border))", backgroundColor: "hsl(var(--popover))", color: "hsl(var(--popover-foreground))", borderRadius: "8px", overflow: "hidden", boxShadow: "0 8px 24px #0002" },
      }),
    ];
  };
  const attach = (state: EditorState) => configureAgentComposerState(state, ui.of(extensions()));
  useLayoutEffect(() => {
    const view = new EditorView({ state: attach(latest.current.state), parent: host.current! });
    editor.current = view;
    return () => { editor.current = undefined; view.destroy(); };
  }, []);
  useLayoutEffect(() => {
    const view = editor.current;
    if (view && props.state !== publishedState.current && props.state !== view.state) view.setState(attach(props.state));
    publishedState.current = props.state;
  }, [props.state]);
  const configured = useRef({ connectionName: props.connectionName, disabled: props.disabled, placeholder: props.placeholder });
  useLayoutEffect(() => {
    const previous = configured.current;
    if (previous.connectionName === props.connectionName && previous.disabled === props.disabled && previous.placeholder === props.placeholder) return;
    configured.current = { connectionName: props.connectionName, disabled: props.disabled, placeholder: props.placeholder };
    scope.current = null; editor.current?.dispatch({ effects: ui.reconfigure(extensions()) });
  }, [props.connectionName, props.disabled, props.placeholder]);
  useEffect(() => {
    if (props.connectionName) void ensureAutocompleteFor(props.connectionName).catch(() => {});
  }, [props.connectionName]);
  const tools = <>
    <button type="button" title={t("agent.composer.reference")} aria-label={t("agent.composer.reference")} className="stela-composer-action" onClick={() => {
      const view = editor.current; if (!view || props.disabled) return;
      const head = view.state.selection.main.head, previous = view.state.sliceDoc(Math.max(0, head - 1), head);
      view.dispatch({ changes: { from: head, insert: previous && !/\s/.test(previous) ? " @" : "@" }, selection: { anchor: head + (previous && !/\s/.test(previous) ? 2 : 1) } }); view.focus(); startCompletion(view);
    }}><AtSign size={14} /></button>
    <button type="button" title={`${t("agent.composer.format")} (⌘/Ctrl+Alt+L)`} aria-label={t("agent.composer.format")} className="stela-composer-action" onClick={format}><Braces size={14} /></button>
  </>;
  return <div className={`stela-agent-composer ${props.className ?? ""} ${props.disabled ? "is-disabled" : ""}`}>
    <div className="stela-composer-editing" onMouseDownCapture={event => {
      if (props.disabled || (event.target as HTMLElement).closest(".cm-tooltip, button")) return;
      if (!(event.target as HTMLElement).closest(".cm-content")) event.preventDefault();
      editor.current?.focus();
    }}><div ref={host} /></div>
    {hint && <div role="status" className="px-3 pb-1 text-[11px] text-muted-foreground">{hint}</div>}
    <div className="stela-composer-footer">{props.renderActions?.(tools) ?? tools}</div>
  </div>;
});
