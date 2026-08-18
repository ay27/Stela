import assert from "node:assert/strict";

import { Schema, type Node as ProseNode } from "@milkdown/prose/model";
import { EditorState, Selection } from "@milkdown/prose/state";

import {
  BlockRangeSelection,
  collectSelectedBlockSpans,
  createBlockRangeSelection,
  resolveBlockSpanAtPos,
  type BlockSpan,
} from "./block-selection";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { content: "text*", group: "block" },
    code_block: { content: "text*", group: "block", code: true },
    blockquote: { content: "block+", group: "block" },
    bullet_list: { content: "list_item+", group: "block" },
    list_item: { content: "paragraph block*" },
    table: { content: "table_row+", group: "block", tableRole: "table" },
    table_row: { content: "table_cell+", tableRole: "row" },
    table_cell: { content: "block+", tableRole: "cell" },
    text: {},
  },
});

const text = (value: string) => schema.text(value);
const paragraph = (value: string) =>
  schema.nodes.paragraph.create(null, value ? text(value) : undefined);
const listItem = (value: string) =>
  schema.nodes.list_item.create(null, paragraph(value));

function makeDoc(): ProseNode {
  return schema.nodes.doc.create(null, [
    paragraph("alpha"),
    schema.nodes.bullet_list.create(null, [listItem("one"), listItem("two")]),
    schema.nodes.blockquote.create(null, paragraph("quote")),
    schema.nodes.table.create(null,
      schema.nodes.table_row.create(null,
        schema.nodes.table_cell.create(null, paragraph("cell")),
      ),
    ),
    schema.nodes.code_block.create(null, text("select 1")),
  ]);
}

function positionsByType(doc: ProseNode, typeName: string): number[] {
  const positions: number[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === typeName) positions.push(pos);
  });
  return positions;
}

function requiredSpan(span: BlockSpan | null): BlockSpan {
  assert.ok(span);
  return span;
}

function checkBoundaryResolution(): void {
  const doc = makeDoc();
  const paragraphs = positionsByType(doc, "paragraph");
  const listItems = positionsByType(doc, "list_item");
  const blockquote = positionsByType(doc, "blockquote")[0];
  const table = positionsByType(doc, "table")[0];

  assert.deepEqual(resolveBlockSpanAtPos(doc, 0), {
    from: 0,
    to: doc.child(0).nodeSize,
  });

  const firstListSpan = requiredSpan(
    resolveBlockSpanAtPos(doc, paragraphs[1] + 1),
  );
  assert.deepEqual(firstListSpan, {
    from: listItems[0],
    to: listItems[0] + doc.nodeAt(listItems[0])!.nodeSize,
  });

  const quoteSpan = requiredSpan(
    resolveBlockSpanAtPos(doc, paragraphs[3] + 1),
  );
  assert.deepEqual(quoteSpan, {
    from: blockquote,
    to: blockquote + doc.nodeAt(blockquote)!.nodeSize,
  });

  const tableSpan = requiredSpan(
    resolveBlockSpanAtPos(doc, paragraphs[4] + 1),
  );
  assert.deepEqual(tableSpan, {
    from: table,
    to: table + doc.nodeAt(table)!.nodeSize,
  });
}

function checkForwardAndReverseRanges(): void {
  const doc = makeDoc();
  const first = requiredSpan(resolveBlockSpanAtPos(doc, 0));
  const quoteParagraph = positionsByType(doc, "paragraph")[3];
  const quote = requiredSpan(resolveBlockSpanAtPos(doc, quoteParagraph + 1));

  const forward = createBlockRangeSelection(doc, first, quote);
  const reverse = createBlockRangeSelection(doc, quote, first);
  assert.equal(forward.from, first.from);
  assert.equal(forward.to, quote.to);
  assert.equal(forward.anchor, first.from);
  assert.equal(forward.head, quote.to);
  assert.equal(reverse.from, first.from);
  assert.equal(reverse.to, quote.to);
  assert.equal(reverse.anchor, quote.to);
  assert.equal(reverse.head, first.from);

  const selected = collectSelectedBlockSpans(doc, forward.from, forward.to);
  assert.deepEqual(
    selected.map((span) => doc.nodeAt(span.from)?.type.name),
    ["paragraph", "list_item", "list_item", "blockquote"],
  );
}

function checkClipboardAndDeletionSemantics(): void {
  const doc = makeDoc();
  const listItems = positionsByType(doc, "list_item");
  const first = requiredSpan(resolveBlockSpanAtPos(doc, listItems[0]));
  const second = requiredSpan(resolveBlockSpanAtPos(doc, listItems[1]));
  const selection = createBlockRangeSelection(doc, first, second);

  assert.equal(
    selection.content().content.textBetween(
      0,
      selection.content().content.size,
      "|",
    ),
    "one|two",
  );

  const state = EditorState.create({ doc, selection });
  const tr = state.tr.deleteSelection();
  assert.equal(tr.doc.textContent, "alphaquotecellselect 1");
  assert.equal(positionsByType(tr.doc, "bullet_list").length, 0);
}

function checkWholeDocumentDeletionAndSerialization(): void {
  const doc = makeDoc();
  const first = requiredSpan(resolveBlockSpanAtPos(doc, 0));
  const codePos = positionsByType(doc, "code_block")[0];
  const last = requiredSpan(resolveBlockSpanAtPos(doc, codePos));
  const selection = createBlockRangeSelection(doc, first, last);
  assert.equal(selection.from, 0);
  assert.equal(selection.to, doc.content.size);

  const restored = Selection.fromJSON(doc, selection.toJSON());
  assert.ok(restored instanceof BlockRangeSelection);
  assert.ok(restored.eq(selection));

  const state = EditorState.create({ doc, selection });
  const tr = state.tr.deleteSelection();
  assert.equal(tr.doc.childCount, 1);
  assert.equal(tr.doc.firstChild?.type.name, "paragraph");
  assert.equal(tr.doc.textContent, "");
}

checkBoundaryResolution();
checkForwardAndReverseRanges();
checkClipboardAndDeletionSemantics();
checkWholeDocumentDeletionAndSerialization();

console.log("block-selection: ok");
