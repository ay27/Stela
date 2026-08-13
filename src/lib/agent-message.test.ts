import assert from "node:assert/strict";
import { redo, undo } from "@milkdown/prose/history";
import { TextSelection } from "@milkdown/prose/state";

import { agentMessagePlainText, withAgentResourceId } from "@shared/agent-message";
import {
  agentComposerSuggestionKey,
  agentComposerClipboardText,
  agentComposerStateToMessage,
  createAgentComposerState,
  handleAgentComposerSuggestionKey,
  insertAgentComposerResource,
  isAgentComposerEmpty,
  placeAgentComposerSuggestions,
  setAgentComposerSuggestionCandidates,
} from "./agent-composer";
import { composeAgentMessage } from "./agent-message";

const runsql = withAgentResourceId({
  kind: "runsql",
  label: "Orders query",
  sql: "select * from orders",
  sourcePath: "orders.md",
  locator: { blockId: "block_1", blockIndex: 0 },
});

const first = composeAgentMessage("Compare ", runsql, " with yesterday\nthen explain");
const firstState = createAgentComposerState(first);
assert.deepEqual(agentComposerStateToMessage(firstState), first, "message round-trips through ProseMirror");
assert.equal(isAgentComposerEmpty(firstState), false);

const duplicateState = insertAgentComposerResource(firstState, runsql, {
  collapseSelectionToHead: true,
});
const duplicateMessage = agentComposerStateToMessage(duplicateState);
assert.equal(duplicateMessage.resources.length, 1, "duplicate occurrences share one resource body");
assert.equal(
  duplicateMessage.segments.filter((segment) => segment.kind === "resource").length,
  2,
  "duplicate occurrences retain both positions",
);

const mixedMessage = {
  version: 1 as const,
  segments: [{ kind: "text" as const, text: "中文ABC混合123" }],
  resources: [],
};
let mixedState = createAgentComposerState(mixedMessage);
mixedState = mixedState.apply(
  mixedState.tr.setSelection(TextSelection.create(mixedState.doc, 1 + "中文ABC".length)),
);
mixedState = insertAgentComposerResource(mixedState, runsql, { collapseSelectionToHead: true });
mixedState = mixedState.apply(mixedState.tr.insertText("AFTER"));
assert.equal(
  agentMessagePlainText(agentComposerStateToMessage(mixedState)),
  "中文ABC [runsql: Orders query] AFTER混合123",
  "typing after an external pill uses the transaction selection after the pill",
);

let selectedState = createAgentComposerState({
  version: 1,
  segments: [{ kind: "text", text: "keep selected text" }],
  resources: [],
});
selectedState = selectedState.apply(
  selectedState.tr.setSelection(TextSelection.create(selectedState.doc, 1, 5)),
);
selectedState = insertAgentComposerResource(selectedState, runsql, { collapseSelectionToHead: true });
assert.match(
  agentMessagePlainText(agentComposerStateToMessage(selectedState)),
  /^keep \[runsql: Orders query\] selected text$/,
  "external insertion collapses to the selection head without deleting selected draft text",
);

let suggestionState = createAgentComposerState({ version: 1, segments: [], resources: [] });
suggestionState = suggestionState.apply(suggestionState.tr.insertText("@ord"));
const activeSuggestion = agentComposerSuggestionKey.getState(suggestionState)?.active;
assert.equal(activeSuggestion?.query, "ord");
assert.ok(activeSuggestion);
const candidateTransaction = setAgentComposerSuggestionCandidates(suggestionState, activeSuggestion, [runsql]);
assert.ok(candidateTransaction);
suggestionState = suggestionState.apply(candidateTransaction);
const acceptTransaction = handleAgentComposerSuggestionKey(suggestionState, "Enter");
assert.ok(acceptTransaction);
suggestionState = suggestionState.apply(acceptTransaction);
assert.equal(
  agentComposerSuggestionKey.getState(suggestionState)?.active,
  null,
  "accepting an @ candidate closes the suggestion popup in the same transaction",
);
assert.equal(
  agentMessagePlainText(agentComposerStateToMessage(suggestionState)),
  "[runsql: Orders query] ",
  "accepting an @ candidate replaces the trigger and leaves an editable trailing space",
);

let staleSuggestionState = createAgentComposerState({ version: 1, segments: [], resources: [] });
staleSuggestionState = staleSuggestionState.apply(staleSuggestionState.tr.insertText("@old"));
const staleRange = agentComposerSuggestionKey.getState(staleSuggestionState)?.active;
assert.ok(staleRange);
staleSuggestionState = staleSuggestionState.apply(staleSuggestionState.tr.insertText("er"));
assert.equal(
  setAgentComposerSuggestionCandidates(staleSuggestionState, staleRange, [runsql]),
  null,
  "stale async candidates cannot replace results for a newer query",
);

let historyState = createAgentComposerState({
  version: 1,
  segments: [{ kind: "text", text: "before" }],
  resources: [],
});
historyState = insertAgentComposerResource(historyState, runsql, { collapseSelectionToHead: true });
assert.equal(agentComposerStateToMessage(historyState).resources.length, 1);
assert.equal(undo(historyState, (transaction) => { historyState = historyState.apply(transaction); }), true);
assert.equal(agentMessagePlainText(agentComposerStateToMessage(historyState)), "before");
assert.equal(redo(historyState, (transaction) => { historyState = historyState.apply(transaction); }), true);
assert.match(agentMessagePlainText(agentComposerStateToMessage(historyState)), /Orders query/);

const clipboardSlice = duplicateState.doc.slice(1, duplicateState.doc.content.size - 1);
const clipboard = agentComposerClipboardText(clipboardSlice);
assert.match(clipboard, /@RunSQL · Orders query/, "clipboard contains only visible resource text");
assert.doesNotMatch(clipboard, /select \* from orders/, "clipboard omits hidden SQL bodies");

const missingState = createAgentComposerState({
  version: 1,
  segments: [{ kind: "resource", resourceId: "missing" }],
  resources: [],
});
assert.equal(agentMessagePlainText(agentComposerStateToMessage(missingState)), "[missing resource]");

const rightEdgePlacement = placeAgentComposerSuggestions({
  anchorTop: 200,
  anchorBottom: 220,
  anchorLeft: 1180,
  editorWidth: 320,
  viewportWidth: 1200,
  viewportHeight: 800,
});
assert.ok(
  rightEdgePlacement.left + rightEdgePlacement.width <= 1192,
  "suggestions stay inside the right viewport edge",
);
const bottomEdgePlacement = placeAgentComposerSuggestions({
  anchorTop: 740,
  anchorBottom: 760,
  anchorLeft: 900,
  editorWidth: 320,
  viewportWidth: 1200,
  viewportHeight: 800,
});
assert.equal(bottomEdgePlacement.placement, "above", "suggestions flip above near the bottom edge");
assert.ok(
  bottomEdgePlacement.top - bottomEdgePlacement.maxHeight >= 8,
  "flipped suggestions stay inside the top viewport edge",
);

console.log("agent composer message tests passed.");
