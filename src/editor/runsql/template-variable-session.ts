import { EditorState, type ChangeDesc } from "@codemirror/state";

import type { TemplateVariableField } from "./sql-template-snippet";

export interface TemplateVariableSession {
  fields: TemplateVariableField[];
  activeIndex: number;
}

/** Required for linked placeholders to remain simultaneous CM selections. */
export const templateMultiSelectionExtension =
  EditorState.allowMultipleSelections.of(true);

export function advanceTemplateVariableSession(
  session: TemplateVariableSession,
  direction: 1 | -1,
): TemplateVariableField | null {
  const nextIndex = session.activeIndex + direction;
  if (nextIndex < 0 || nextIndex >= session.fields.length) return null;
  session.activeIndex = nextIndex;
  return session.fields[nextIndex]!;
}

export function mapTemplateVariableSession(
  session: TemplateVariableSession,
  changes: ChangeDesc,
): void {
  session.fields = session.fields.map((field) => ({
    name: field.name,
    ranges: field.ranges.map((range) => ({
      from: changes.mapPos(range.from, -1),
      to: changes.mapPos(range.to, 1),
    })),
  }));
}
