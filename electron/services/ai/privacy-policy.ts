import type { ColumnDef } from '../../shared/types';
import { MySQL } from '@codemirror/lang-sql';
import type { SyntaxNode } from '@lezer/common';

export interface IPrivacySource {
  runId: string;
  columns: ColumnDef[];
  rows: unknown[][];
  rowCount: number;
  connectionName?: string;
  sql?: string;
}
export type { IPrivacySelection, IPrivacyReleaseOption, IPrivacyReleaseRequest } from '../../shared/ai-privacy';
import type { IPrivacySelection, IPrivacyReleaseOption } from '../../shared/ai-privacy';

/** Evidence about the actual expression, never a result alias or digit length. */
export function countColumns(sql: string | undefined, columns: readonly ColumnDef[]): Set<number> {
  if (!sql || sql.length > 100_000 || !columns.length) return new Set();
  const id = '(?:[A-Za-z_][A-Za-z0-9_]*|"[A-Za-z_][A-Za-z0-9_]*"|`[A-Za-z_][A-Za-z0-9_]*`)';
  const tree = MySQL.language.parser.parse(sql);
  const text = (node: SyntaxNode) => sql.slice(node.from, node.to);
  const children = (node: SyntaxNode) => {
    const result: SyntaxNode[] = [];
    for (let child = node.firstChild; child; child = child.nextSibling) result.push(child);
    return result;
  };
  let selects = 0;
  const cursor = tree.cursor();
  do {
    if (cursor.type.isError || /Comment/.test(cursor.name)) return new Set();
    if (cursor.name === 'Keyword') {
      const word = sql.slice(cursor.from, cursor.to).toUpperCase();
      if (['WITH', 'UNION', 'INTERSECT', 'EXCEPT', 'INTO'].includes(word)) return new Set();
      if (word === 'SELECT') selects++;
    }
  } while (cursor.next());
  const statements = children(tree.topNode).filter(node => node.name === 'Statement');
  if (selects !== 1 || statements.length !== 1) return new Set();
  const nodes = children(statements[0]!);
  if (text(nodes[0]!).toUpperCase() !== 'SELECT') return new Set();
  const from = nodes.findIndex(node => node.name === 'Keyword' && text(node).toUpperCase() === 'FROM');
  if (from < 2) return new Set();
  const projections: SyntaxNode[][] = [[]];
  for (const node of nodes.slice(1, from)) {
    if (node.name === 'Punctuation' && text(node) === ',') projections.push([]);
    else projections.at(-1)!.push(node);
  }
  // Wildcard expansion makes projection ordinals ambiguous. Reject it even
  // when a connector happens to return the same number of columns.
  if (projections.length !== columns.length || projections.some(parts => !parts.length || parts.some(node => text(node) === '*' || /^COLUMNS$/i.test(text(node))))) return new Set();
  const directCount = new RegExp(`^COUNT\\s*\\(\\s*(?:\\*|(?:DISTINCT\\s+)?${id}(?:\\.${id})?)\\s*\\)(?:\\s+(?:AS\\s+)?${id})?$`, 'i');
  const alias = new RegExp(`^(?:\\s+(?:AS\\s+)?${id})?$`, 'i');
  const result = new Set<number>();
  projections.forEach((parts, index) => {
    const expression = sql.slice(parts[0]!.from, parts.at(-1)!.to);
    if (directCount.test(expression)) { result.add(index); return; }
    // A binary CASE SUM counts matching/nonmatching rows; SUM(data), arithmetic,
    // nested branches and window expressions never get this exception.
    const parens = parts[1];
    if (!/^SUM$/i.test(text(parts[0]!)) || parens?.name !== 'Parens' || !alias.test(sql.slice(parens.to, parts.at(-1)!.to))) return;
    const body = children(parens).slice(1, -1);
    const branches = body.map((node, i) => ({ word: node.name === 'Keyword' ? text(node).toUpperCase() : '', i }))
      .filter(({ word }) => ['CASE', 'WHEN', 'THEN', 'ELSE', 'END'].includes(word));
    if (branches.map(item => item.word).join(' ') !== 'CASE WHEN THEN ELSE END') return;
    const [start, when, then, otherwise, end] = branches;
    if (start!.i !== 0 || when!.i !== 1 || then!.i <= 2 || otherwise!.i !== then!.i + 2 || end!.i !== otherwise!.i + 2 || end!.i !== body.length - 1) return;
    if ([body[then!.i + 1]!, body[otherwise!.i + 1]!].every(node => node.name === 'Number' && /^[01]$/.test(text(node)))) result.add(index);
  });
  return result;
}
export function parseJsonContainer(value: unknown): unknown {
  if (typeof value !== 'string' || !/^[\s]*[\[{]/.test(value)) return value;
  try { const parsed: unknown = JSON.parse(value); return parsed && typeof parsed === 'object' ? parsed : value; }
  catch { return value; }
}
export function secretLabel(label: string): boolean {
  return /(?:^|[_\W])(?:password|passwd|pwd|token|secret|api[_-]?key|authorization|bearer)(?:$|[_\W])/i.test(label);
}
export function structuralKey(key: string): boolean { return /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key); }
export function selectionAllows(selections: readonly IPrivacySelection[], column: number, path: string[]): boolean {
  return selections.some(s => s.column === column && s.path.length <= path.length && s.path.every((part, i) => part === path[i]));
}
export function releaseOptions(source: IPrivacySource): IPrivacyReleaseOption[] {
  const options: IPrivacyReleaseOption[] = [];
  const seen = new Set<string>();
  const add = (column: number, path: string[], samples: unknown[]) => {
    const key = JSON.stringify([column, path]);
    if (seen.has(key) || options.length >= 128) return;
    seen.add(key);
    options.push({ id: String(options.length), column, path,
      label: `${column + 1}. ${source.columns[column]!.name}${path.length ? ' / ' + path.join(' / ') : ''}`,
      samples: [...new Set(samples.filter(v => v != null).map(v => typeof v === 'string' ? v : JSON.stringify(v)))].slice(0, 3).map(v => v.slice(0, 160)),
    });
  };
  const visit = (column: number, value: unknown, path: string[], depth: number) => {
    if (depth > 8 || options.length >= 128) return;
    const parsed = parseJsonContainer(value);
    if (Array.isArray(parsed)) { for (const v of parsed.slice(0, 3)) visit(column, v, [...path, '*'], depth + 1); }
    else if (parsed && typeof parsed === 'object') {
      for (const [key, v] of Object.entries(parsed).slice(0, 32)) {
        if (!secretLabel(key)) visit(column, v, [...path, key], depth + 1);
      }
    } else if (path.length) add(column, path, [value]);
  };
  source.columns.forEach((col, column) => {
    if (secretLabel(col.name)) return;
    const samples = source.rows.slice(0, 3).map(row => row[column]);
    add(column, [], samples);
    for (const value of samples) visit(column, value, [], 0);
  });
  return options;
}
