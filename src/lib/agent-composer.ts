import { EditorState, StateEffect, StateField, MapMode, type TransactionSpec, type Extension } from "@codemirror/state";
import { history, invertedEffects } from "@codemirror/commands";
import { compactAgentMessage, withAgentResourceId } from "@shared/agent-message";
import type { AgentMessageContent, AgentMessageResource, AgentMessageResourceInput, AgentMessageSegment } from "@shared/types";

export interface IComposerResource { from: number; resource: AgentMessageResource }
export const RESOURCE_CHARACTER = "\uFFFC";
const restoreResources = StateEffect.define<readonly IComposerResource[]>({
  map: (value, changes) => value.flatMap(item => {
    const from = changes.mapPos(item.from, 1, MapMode.TrackDel);
    return from === null ? [] : [{ ...item, from }];
  }),
});
export const composerResources = StateField.define<readonly IComposerResource[]>({
  create: () => [],
  update: (previous, tr) => {
    if (!tr.docChanged && !tr.effects.some(effect => effect.is(restoreResources))) return previous;
    let next = previous.flatMap(item => {
      let removed = false;
      tr.changes.iterChangedRanges((from, to) => { if (from <= item.from && to > item.from) removed = true; });
      return removed ? [] : [{ ...item, from: tr.changes.mapPos(item.from, 1) }];
    });
    for (const effect of tr.effects) if (effect.is(restoreResources)) next = [...effect.value];
    return next.filter(item => tr.newDoc.sliceString(item.from, item.from + 1) === RESOURCE_CHARACTER).sort((a, b) => a.from - b.from);
  },
});
const resourceHistory = invertedEffects.of(tr => tr.docChanged || tr.effects.some(e => e.is(restoreResources))
  ? [restoreResources.of(tr.startState.field(composerResources))] : []);
const modelExtensions: Extension = [composerResources, history(), resourceHistory];

/** Replace view configuration instead of appending it. Persist only model fields,
 * so reopening a draft (including after HMR) cannot retain stale completion overrides. */
export function configureAgentComposerState(state: EditorState, viewExtensions: Extension = []): EditorState {
  return state.update({ effects: StateEffect.reconfigure.of([modelExtensions, viewExtensions]) }).state;
}

const labels: Record<AgentMessageResource["kind"], string> = { table: "Table", note: "Doc", canvas: "Canvas", runsql: "RunSQL", selection: "Selection" };
export function agentResourceDisplay(resource: Pick<AgentMessageResource, "kind" | "label">): string {
  return `@${labels[resource.kind]} · ${resource.label}`;
}
export function createAgentComposerState(message: AgentMessageContent): EditorState {
  let doc = "";
  const occurrences: IComposerResource[] = [];
  const catalog = new Map(message.resources.map(r => [r.id, r]));
  for (const segment of message.segments) {
    if (segment.kind === "text") doc += segment.text.replace(/\r\n?/g, "\n");
    else {
      const resource = catalog.get(segment.resourceId);
      if (!resource) { doc += "[missing resource]"; continue; }
      occurrences.push({ from: doc.length, resource }); doc += RESOURCE_CHARACTER;
    }
  }
  return EditorState.create({ doc, selection: { anchor: doc.length }, extensions: [
    modelExtensions, composerResources.init(() => occurrences),
  ] });
}
export function emptyAgentComposerState(): EditorState {
  return createAgentComposerState({ version: 1, segments: [], resources: [] });
}
const messageCache = new WeakMap<EditorState, AgentMessageContent>();
export function agentComposerStateToMessage(state: EditorState): AgentMessageContent {
  const cached = messageCache.get(state);
  if (cached) return cached;
  const segments: AgentMessageSegment[] = [];
  const resources: AgentMessageResource[] = [];
  let pos = 0;
  for (const item of state.field(composerResources)) {
    if (item.from > pos) segments.push({ kind: "text", text: state.doc.sliceString(pos, item.from) });
    segments.push({ kind: "resource", resourceId: item.resource.id });
    if (!resources.some(r => r.id === item.resource.id)) resources.push(item.resource);
    pos = item.from + 1;
  }
  if (pos < state.doc.length) segments.push({ kind: "text", text: state.doc.sliceString(pos) });
  const message = compactAgentMessage({ version: 1, segments, resources });
  messageCache.set(state, message);
  return message;
}
export function isAgentComposerEmpty(state: EditorState): boolean {
  return !state.doc.toString().trim();
}
export function insertAgentComposerResourceTransaction(state: EditorState, input: AgentMessageResourceInput | AgentMessageResource,
  options: { from?: number; to?: number; collapseSelectionToHead?: boolean; trailingSpaceAtEnd?: boolean } = {}): TransactionSpec {
  const resource = "id" in input ? input : withAgentResourceId(input);
  const from = options.from ?? (options.collapseSelectionToHead ? state.selection.main.head : state.selection.main.from);
  const to = options.to ?? (options.collapseSelectionToHead ? from : state.selection.main.to);
  const before = state.doc.sliceString(Math.max(0, from - 1), from);
  const after = state.doc.sliceString(to, to + 1);
  const leading = before && !/\s/.test(before) ? " " : "";
  const trailing = after ? (/\s/.test(after) ? "" : " ") : options.trailingSpaceAtEnd ? " " : "";
  const insert = leading + RESOURCE_CHARACTER + trailing;
  const changes = state.changes({ from, to, insert });
  const mapped = state.field(composerResources).filter(r => r.from < from || r.from >= to)
    .map(r => ({ ...r, from: changes.mapPos(r.from, 1) }));
  return { changes, effects: restoreResources.of([...mapped, { from: from + leading.length, resource }]),
    selection: { anchor: from + insert.length }, userEvent: "input.complete" };
}
export function insertAgentComposerResource(state: EditorState, input: AgentMessageResourceInput | AgentMessageResource,
  options: Parameters<typeof insertAgentComposerResourceTransaction>[2] = {}): EditorState {
  return state.update(insertAgentComposerResourceTransaction(state, input, options)).state;
}
export function agentComposerClipboardText(state: EditorState, from = 0, to = state.doc.length): string {
  let text = "", pos = from;
  for (const item of state.field(composerResources)) {
    if (item.from < from || item.from >= to) continue;
    text += state.doc.sliceString(pos, item.from) + agentResourceDisplay(item.resource); pos = item.from + 1;
  }
  return text + state.doc.sliceString(pos, to);
}
