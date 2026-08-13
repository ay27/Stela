import { baseKeymap } from "@milkdown/prose/commands";
import { history, redo, undo } from "@milkdown/prose/history";
import { keymap } from "@milkdown/prose/keymap";
import { Fragment, Schema, Slice, type Node as ProseNode } from "@milkdown/prose/model";
import {
  EditorState,
  Plugin,
  PluginKey,
  TextSelection,
  type Transaction,
} from "@milkdown/prose/state";

import {
  compactAgentMessage,
  withAgentResourceId,
} from "@shared/agent-message";
import type {
  AgentMessageContent,
  AgentMessageResource,
  AgentMessageResourceInput,
  AgentMessageSegment,
} from "@shared/types";

export const AGENT_RESOURCE_NODE = "agent_resource";
const HARD_BREAK_NODE = "hard_break";

export interface AgentComposerSuggestionPlacement {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
  placement: "above" | "below";
}

export function placeAgentComposerSuggestions(input: {
  anchorTop: number;
  anchorBottom: number;
  anchorLeft: number;
  editorWidth: number;
  viewportWidth: number;
  viewportHeight: number;
}): AgentComposerSuggestionPlacement {
  const viewportPadding = 8;
  const anchorGap = 4;
  const preferredMaxHeight = 220;
  const availableWidth = Math.max(0, input.viewportWidth - viewportPadding * 2);
  const preferredWidth = Math.max(220, Math.min(360, input.editorWidth));
  const width = Math.min(preferredWidth, availableWidth);
  const maxLeft = Math.max(viewportPadding, input.viewportWidth - viewportPadding - width);
  const left = Math.min(Math.max(viewportPadding, input.anchorLeft), maxLeft);
  const availableBelow = Math.max(
    0,
    input.viewportHeight - viewportPadding - input.anchorBottom - anchorGap,
  );
  const availableAbove = Math.max(0, input.anchorTop - viewportPadding - anchorGap);
  const placement = availableBelow < Math.min(160, preferredMaxHeight) && availableAbove > availableBelow
    ? "above"
    : "below";
  const availableHeight = placement === "above" ? availableAbove : availableBelow;

  return {
    top: placement === "above" ? input.anchorTop - anchorGap : input.anchorBottom + anchorGap,
    left,
    width,
    maxHeight: Math.min(preferredMaxHeight, availableHeight),
    placement,
  };
}

const TYPE_LABEL: Record<AgentMessageResource["kind"], string> = {
  table: "Table",
  note: "Doc",
  canvas: "Canvas",
  runsql: "RunSQL",
  selection: "Selection",
};

export function agentResourceDisplay(resource: Pick<AgentMessageResource, "kind" | "label">): string {
  return `@${TYPE_LABEL[resource.kind]} · ${resource.label}`;
}

export const agentComposerSchema = new Schema({
  nodes: {
    doc: { content: "paragraph" },
    paragraph: {
      content: "inline*",
      toDOM: () => ["p", 0],
    },
    text: { group: "inline" },
    [HARD_BREAK_NODE]: {
      inline: true,
      group: "inline",
      selectable: false,
      leafText: () => "\n",
      toDOM: () => ["br"],
    },
    [AGENT_RESOURCE_NODE]: {
      inline: true,
      group: "inline",
      atom: true,
      selectable: false,
      attrs: {
        resourceId: {},
        kind: {},
        label: {},
      },
      leafText: (node) => agentResourceDisplay({
        kind: node.attrs.kind as AgentMessageResource["kind"],
        label: node.attrs.label as string,
      }),
      toDOM: (node) => {
        const kind = node.attrs.kind as AgentMessageResource["kind"];
        const label = node.attrs.label as string;
        return [
          "span",
          {
            class: `stela-agent-resource-pill stela-agent-resource-pill--${kind}`,
            "data-agent-resource-id": node.attrs.resourceId as string,
            "data-agent-resource-kind": kind,
            contenteditable: "false",
          },
          agentResourceDisplay({ kind, label }),
        ];
      },
    },
  },
});

interface AgentResourceCatalogState {
  resources: ReadonlyMap<string, AgentMessageResource>;
}

interface AgentResourceCatalogMeta {
  upsert: AgentMessageResource[];
}

const resourceCatalogKey = new PluginKey<AgentResourceCatalogState>("stela-agent-resource-catalog");

function createResourceCatalogPlugin(initial: AgentMessageResource[]): Plugin<AgentResourceCatalogState> {
  const initialResources = new Map(initial.map((resource) => [resource.id, resource]));
  return new Plugin<AgentResourceCatalogState>({
    key: resourceCatalogKey,
    state: {
      init: () => ({ resources: initialResources }),
      apply: (transaction, previous) => {
        const meta = transaction.getMeta(resourceCatalogKey) as AgentResourceCatalogMeta | undefined;
        if (!meta?.upsert.length) return previous;
        const resources = new Map(previous.resources);
        for (const resource of meta.upsert) resources.set(resource.id, resource);
        return { resources };
      },
    },
  });
}

export interface AgentComposerSuggestionRange {
  from: number;
  to: number;
  query: string;
}

export interface AgentComposerSuggestionState {
  active: AgentComposerSuggestionRange | null;
  candidates: AgentMessageResource[];
  selectedIndex: number;
  dismissedKey: string | null;
}

type AgentComposerSuggestionMeta =
  | { type: "close" }
  | { type: "set-candidates"; activeKey: string; candidates: AgentMessageResource[] }
  | { type: "select"; selectedIndex: number };

export const agentComposerSuggestionKey = new PluginKey<AgentComposerSuggestionState>(
  "stela-agent-resource-suggestion",
);

const EMPTY_SUGGESTION_STATE: AgentComposerSuggestionState = {
  active: null,
  candidates: [],
  selectedIndex: 0,
  dismissedKey: null,
};

export function agentComposerSuggestionRangeKey(range: AgentComposerSuggestionRange): string {
  return `${range.from}:${range.to}:${range.query}`;
}

function detectResourceTrigger(state: EditorState): AgentComposerSuggestionRange | null {
  const selection = state.selection;
  if (!selection.empty || !selection.$from.parent.isTextblock) return null;
  const parentOffset = selection.$from.parentOffset;
  const before = selection.$from.parent.textBetween(0, parentOffset, "\n", "\uFFFC");
  const match = /(?:^|\s)@([^@\n\uFFFC]*)$/.exec(before);
  if (!match) return null;
  const query = match[1] ?? "";
  return {
    from: selection.from - query.length - 1,
    to: selection.from,
    query,
  };
}

const suggestionPlugin = new Plugin<AgentComposerSuggestionState>({
  key: agentComposerSuggestionKey,
  state: {
    init: () => EMPTY_SUGGESTION_STATE,
    apply: (transaction, previous, _oldState, newState) => {
      const detected = detectResourceTrigger(newState);
      const detectedKey = detected ? agentComposerSuggestionRangeKey(detected) : null;
      const meta = transaction.getMeta(agentComposerSuggestionKey) as AgentComposerSuggestionMeta | undefined;

      if (meta?.type === "close") {
        return detected
          ? { ...EMPTY_SUGGESTION_STATE, dismissedKey: detectedKey }
          : EMPTY_SUGGESTION_STATE;
      }
      if (!detected || detectedKey === previous.dismissedKey) {
        return detectedKey === previous.dismissedKey ? previous : EMPTY_SUGGESTION_STATE;
      }
      const previousKey = previous.active ? agentComposerSuggestionRangeKey(previous.active) : null;
      if (meta?.type === "set-candidates" && meta.activeKey === detectedKey) {
        return {
          active: detected,
          candidates: meta.candidates,
          selectedIndex: 0,
          dismissedKey: null,
        };
      }
      if (meta?.type === "select" && previousKey === detectedKey) {
        return {
          ...previous,
          active: detected,
          selectedIndex: Math.max(0, Math.min(meta.selectedIndex, Math.max(0, previous.candidates.length - 1))),
        };
      }
      if (previousKey === detectedKey) return { ...previous, active: detected };
      return {
        active: detected,
        candidates: [],
        selectedIndex: 0,
        dismissedKey: null,
      };
    },
  },
});

function textToInlineNodes(text: string): ProseNode[] {
  const normalized = text.replace(/\r\n?/g, "\n");
  const parts = normalized.split("\n");
  const nodes: ProseNode[] = [];
  parts.forEach((part, index) => {
    if (part) nodes.push(agentComposerSchema.text(part));
    if (index < parts.length - 1) nodes.push(agentComposerSchema.nodes[HARD_BREAK_NODE].create());
  });
  return nodes;
}

function messageToDoc(message: AgentMessageContent): ProseNode {
  const resources = new Map(message.resources.map((resource) => [resource.id, resource]));
  const content: ProseNode[] = [];
  for (const segment of message.segments) {
    if (segment.kind === "text") {
      content.push(...textToInlineNodes(segment.text));
      continue;
    }
    const resource = resources.get(segment.resourceId);
    if (!resource) {
      content.push(agentComposerSchema.text("[missing resource]"));
      continue;
    }
    content.push(agentComposerSchema.nodes[AGENT_RESOURCE_NODE].create({
      resourceId: resource.id,
      kind: resource.kind,
      label: resource.label,
    }));
  }
  return agentComposerSchema.nodes.doc.create(
    null,
    agentComposerSchema.nodes.paragraph.create(null, content),
  );
}

function composerPlugins(resources: AgentMessageResource[]): Plugin[] {
  return [
    createResourceCatalogPlugin(resources),
    suggestionPlugin,
    history(),
    keymap({
      "Mod-z": undo,
      "Shift-Mod-z": redo,
      "Mod-y": redo,
      ...baseKeymap,
    }),
  ];
}

export function createAgentComposerState(message: AgentMessageContent): EditorState {
  const doc = messageToDoc(message);
  return EditorState.create({
    schema: agentComposerSchema,
    doc,
    selection: TextSelection.atEnd(doc),
    plugins: composerPlugins(message.resources),
  });
}

export function emptyAgentComposerState(): EditorState {
  return createAgentComposerState({ version: 1, segments: [], resources: [] });
}

function appendTextSegment(segments: AgentMessageSegment[], text: string): void {
  if (!text) return;
  const previous = segments.at(-1);
  if (previous?.kind === "text") previous.text += text;
  else segments.push({ kind: "text", text });
}

export function agentComposerStateToMessage(state: EditorState): AgentMessageContent {
  const catalog = resourceCatalogKey.getState(state)?.resources ?? new Map<string, AgentMessageResource>();
  const segments: AgentMessageSegment[] = [];
  state.doc.firstChild?.forEach((node) => {
    if (node.isText) appendTextSegment(segments, node.text ?? "");
    else if (node.type.name === HARD_BREAK_NODE) appendTextSegment(segments, "\n");
    else if (node.type.name === AGENT_RESOURCE_NODE) {
      const resourceId = node.attrs.resourceId as string;
      if (catalog.has(resourceId)) segments.push({ kind: "resource", resourceId });
      else appendTextSegment(segments, "[missing resource]");
    }
  });
  return compactAgentMessage({
    version: 1,
    segments,
    resources: [...catalog.values()],
  });
}

export function agentComposerResourceById(
  state: EditorState,
  resourceId: string,
): AgentMessageResource | undefined {
  return resourceCatalogKey.getState(state)?.resources.get(resourceId);
}

export function isAgentComposerEmpty(state: EditorState): boolean {
  let hasResource = false;
  state.doc.descendants((node) => {
    if (node.type.name === AGENT_RESOURCE_NODE) hasResource = true;
  });
  return !hasResource && !state.doc.textContent.trim();
}

function normalizedResource(
  input: AgentMessageResourceInput | AgentMessageResource,
): AgentMessageResource {
  return "id" in input ? input : withAgentResourceId(input);
}

function adjacentText(doc: ProseNode, from: number, to: number): { before: string; after: string } {
  return {
    before: from > 0 ? doc.textBetween(Math.max(0, from - 1), from, "", "\uFFFC") : "",
    after: to < doc.content.size ? doc.textBetween(to, Math.min(doc.content.size, to + 1), "", "\uFFFC") : "",
  };
}

export interface InsertAgentComposerResourceOptions {
  from?: number;
  to?: number;
  collapseSelectionToHead?: boolean;
  trailingSpaceAtEnd?: boolean;
}

export function insertAgentComposerResourceTransaction(
  state: EditorState,
  input: AgentMessageResourceInput | AgentMessageResource,
  options: InsertAgentComposerResourceOptions = {},
): Transaction {
  const resource = normalizedResource(input);
  const selectionHead = state.selection.head;
  const from = options.from ?? (options.collapseSelectionToHead ? selectionHead : state.selection.from);
  const to = options.to ?? (options.collapseSelectionToHead ? selectionHead : state.selection.to);
  const { before, after } = adjacentText(state.doc, from, to);
  const leading = before && !/\s$/.test(before) ? " " : "";
  const trailing = after
    ? (!/^\s/.test(after) ? " " : "")
    : (options.trailingSpaceAtEnd ? " " : "");
  const nodes: ProseNode[] = [];
  if (leading) nodes.push(agentComposerSchema.text(leading));
  nodes.push(agentComposerSchema.nodes[AGENT_RESOURCE_NODE].create({
    resourceId: resource.id,
    kind: resource.kind,
    label: resource.label,
  }));
  if (trailing) nodes.push(agentComposerSchema.text(trailing));
  const fragment = Fragment.fromArray(nodes);
  const transaction = state.tr.replaceWith(from, to, fragment);
  transaction.setSelection(TextSelection.create(transaction.doc, from + fragment.size));
  transaction.setMeta(resourceCatalogKey, { upsert: [resource] } satisfies AgentResourceCatalogMeta);
  transaction.setMeta(agentComposerSuggestionKey, { type: "close" } satisfies AgentComposerSuggestionMeta);
  return transaction;
}

export function insertAgentComposerResource(
  state: EditorState,
  input: AgentMessageResourceInput | AgentMessageResource,
  options: InsertAgentComposerResourceOptions = {},
): EditorState {
  return state.apply(insertAgentComposerResourceTransaction(state, input, options));
}

export function replaceAgentComposerSelectionWithText(state: EditorState, text: string): Transaction {
  const fragment = Fragment.fromArray(textToInlineNodes(text));
  const transaction = state.tr.replaceSelection(new Slice(fragment, 0, 0));
  transaction.setSelection(TextSelection.near(transaction.doc.resolve(transaction.selection.to), 1));
  return transaction;
}

export function insertAgentComposerHardBreak(state: EditorState): Transaction {
  const node = agentComposerSchema.nodes[HARD_BREAK_NODE].create();
  const transaction = state.tr.replaceSelectionWith(node);
  transaction.setSelection(TextSelection.near(transaction.doc.resolve(transaction.selection.to), 1));
  return transaction;
}

export function agentComposerClipboardText(slice: Slice): string {
  return slice.content.textBetween(0, slice.content.size, "\n", (node) => {
    if (node.type.name === HARD_BREAK_NODE) return "\n";
    if (node.type.name === AGENT_RESOURCE_NODE) {
      return agentResourceDisplay({
        kind: node.attrs.kind as AgentMessageResource["kind"],
        label: node.attrs.label as string,
      });
    }
    return "";
  });
}

export function setAgentComposerSuggestionCandidates(
  state: EditorState,
  active: AgentComposerSuggestionRange,
  candidates: AgentMessageResource[],
): Transaction | null {
  const current = agentComposerSuggestionKey.getState(state)?.active;
  if (!current || agentComposerSuggestionRangeKey(current) !== agentComposerSuggestionRangeKey(active)) return null;
  return state.tr.setMeta(agentComposerSuggestionKey, {
    type: "set-candidates",
    activeKey: agentComposerSuggestionRangeKey(active),
    candidates,
  } satisfies AgentComposerSuggestionMeta);
}

export function handleAgentComposerSuggestionKey(
  state: EditorState,
  key: string,
): Transaction | null {
  const suggestion = agentComposerSuggestionKey.getState(state);
  if (!suggestion?.active) return null;
  if (key === "Escape") {
    return state.tr.setMeta(agentComposerSuggestionKey, { type: "close" } satisfies AgentComposerSuggestionMeta);
  }
  if (key === "ArrowDown" || key === "ArrowUp") {
    const length = suggestion.candidates.length;
    const delta = key === "ArrowDown" ? 1 : -1;
    const selectedIndex = length > 0
      ? (suggestion.selectedIndex + delta + length) % length
      : 0;
    return state.tr.setMeta(agentComposerSuggestionKey, {
      type: "select",
      selectedIndex,
    } satisfies AgentComposerSuggestionMeta);
  }
  if (key !== "Enter") return null;
  const resource = suggestion.candidates[suggestion.selectedIndex];
  if (!resource) return state.tr;
  return insertAgentComposerResourceTransaction(state, resource, {
    from: suggestion.active.from,
    to: suggestion.active.to,
    trailingSpaceAtEnd: true,
  });
}
