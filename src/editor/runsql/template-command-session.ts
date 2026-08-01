import { EditorSelection } from "@codemirror/state";
import type { EditorView as CMView } from "@codemirror/view";
import { TextSelection } from "@milkdown/prose/state";
import type { EditorView as PMView } from "@milkdown/prose/view";

import { createTemplateInsertion } from "./sql-template-snippet";
import type { TemplateVariableSession } from "./template-variable-session";

export interface TemplateCommandSnapshot {
  from: number;
  to: number;
  text: string;
}

export type TemplateCommandResult =
  | {
      applied: true;
      session: TemplateVariableSession | null;
      insertionText: string;
      position: number;
    }
  | { applied: false; reason: "target-not-found" | "target-changed" };

export function applyTemplateCommand(options: {
  pm: PMView;
  cm: CMView;
  getPos: () => number | undefined;
  sql: string;
  snapshot: TemplateCommandSnapshot;
}): TemplateCommandResult {
  const { pm, cm, getPos, sql, snapshot } = options;
  const position = getPos();
  const node = position === undefined ? null : pm.state.doc.nodeAt(position);
  if (
    position === undefined ||
    !node ||
    node.type.name !== "code_block" ||
    node.attrs.language !== "runsql"
  ) {
    return { applied: false, reason: "target-not-found" };
  }
  if (
    node.textContent !== snapshot.text ||
    snapshot.from < 0 ||
    snapshot.to < snapshot.from ||
    snapshot.to > snapshot.text.length
  ) {
    return { applied: false, reason: "target-changed" };
  }

  const insertion = createTemplateInsertion(
    snapshot.text,
    snapshot.from,
    snapshot.to,
    sql,
  );
  const content = insertion.text
    ? [pm.state.schema.text(insertion.text)]
    : [];
  const firstRange = insertion.fields[0]?.ranges[0];
  const selectionFrom =
    position + 1 + (firstRange?.from ?? insertion.cursor);
  const selectionTo = position + 1 + (firstRange?.to ?? insertion.cursor);
  const transaction = pm.state.tr.replaceWith(
    position + 1,
    position + node.nodeSize - 1,
    content,
  );
  transaction
    .setSelection(
      TextSelection.create(transaction.doc, selectionFrom, selectionTo),
    )
    .scrollIntoView();
  pm.dispatch(transaction);
  cm.dispatch({
    selection:
      insertion.fields.length > 0
        ? EditorSelection.create(
            insertion.fields[0]!.ranges.map((range) =>
              EditorSelection.range(range.from, range.to),
            ),
          )
        : EditorSelection.cursor(insertion.cursor),
  });
  return {
    applied: true,
    session:
      insertion.fields.length > 0
        ? { fields: insertion.fields, activeIndex: 0 }
        : null,
    insertionText: insertion.text,
    position,
  };
}
