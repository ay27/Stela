import { EditorState, StateField } from "@codemirror/state";
import { sql, type SQLDialect } from "@codemirror/lang-sql";
import { composerSqlRegions, type ISqlRegion } from "./composer-sql";

export interface IComposerSqlRegion extends ISqlRegion { state: EditorState }

/** Reuse incremental SQL states for highlighting and completion, including when
 * surrounding prose moves an unchanged SQL region to another document position. */
export function createComposerSqlField(dialect: SQLDialect) {
  const language = sql({ dialect });
  function regions(doc: string, previous: readonly IComposerSqlRegion[]): IComposerSqlRegion[] {
    return composerSqlRegions(doc).map((region, index) => {
      const text = doc.slice(region.from, region.to);
      const old = previous[index]?.state;
      if (!old) return { ...region, state: EditorState.create({ doc: text, extensions: language }) };
      const before = old.doc.toString();
      if (before === text) return { ...region, state: old };
      let from = 0, oldTo = before.length, newTo = text.length;
      while (from < oldTo && from < newTo && before[from] === text[from]) from++;
      while (oldTo > from && newTo > from && before[oldTo - 1] === text[newTo - 1]) { oldTo--; newTo--; }
      return { ...region, state: old.update({ changes: { from, to: oldTo, insert: text.slice(from, newTo) } }).state };
    });
  }
  return StateField.define<readonly IComposerSqlRegion[]>({
    create: state => regions(state.doc.toString(), []),
    update: (value, tr) => tr.docChanged ? regions(tr.newDoc.toString(), value) : value,
  });
}
