import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";

const MIN_PREFIX_NON_WHITESPACE = 3;

interface SqlCompletionContextOptions {
  /** Manual completion may deliberately extend an otherwise complete statement. */
  allowCompleteStatement?: boolean;
}

function hasSyntaxError(node: SyntaxNode): boolean {
  if (node.name === "⚠") return true;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (hasSyntaxError(child)) return true;
  }
  return false;
}

function endsWithContinuation(sql: string): boolean {
  const trimmed = sql.trimEnd();
  if (/[,(.=<>+\-*/]$/.test(trimmed)) return true;
  return /\b(?:select|from|where|join|left|right|inner|outer|cross|full|on|using|and|or|not|group\s+by|order\s+by|having|limit|offset|union|union\s+all|intersect|except|as|when|then|else|with)\s*$/i.test(
    trimmed,
  );
}

function hasTopLevelSelectFrom(sql: string): boolean {
  const masked = sql.replace(
    /'(?:''|\\.|[^'])*'|`[^`]*`|"(?:""|[^"])*"|--[^\n]*|\/\*[\s\S]*?\*\//g,
    (match) => " ".repeat(match.length),
  );
  let depth = 0;
  let sawSelect = false;
  for (let index = 0; index < masked.length; index += 1) {
    const char = masked[index];
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0 || !/[A-Za-z_]/.test(char)) continue;
    const word = /^[A-Za-z_][\w$]*/.exec(masked.slice(index))?.[0];
    if (!word) continue;
    const keyword = word.toLowerCase();
    if (keyword === "select") sawSelect = true;
    if (sawSelect && keyword === "from") return true;
    index += word.length - 1;
  }
  return false;
}

function isCompleteSelectAtDocumentTail(state: EditorState, pos: number): boolean {
  const suffix = state.doc.sliceString(pos);
  if (suffix.trim()) return false;
  const prefix = state.doc.sliceString(0, pos);
  if (!hasTopLevelSelectFrom(prefix)) return false;
  if (endsWithContinuation(prefix)) return false;
  return !hasSyntaxError(syntaxTree(state).topNode);
}

export function sqlCompletionContextBlockReason(
  state: EditorState,
  pos: number,
  options: SqlCompletionContextOptions = {},
): string | null {
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1);
  while (node) {
    if (/Comment|String/.test(node.name)) return "cursor is inside a comment or string";
    node = node.parent;
  }
  const prefix = state.doc.sliceString(0, pos);
  const suffix = state.doc.sliceString(pos);
  if (`${prefix}${suffix}`.replace(/\s/g, "").length < MIN_PREFIX_NON_WHITESPACE) {
    return "SQL context is too short";
  }
  if (prefix.trimEnd().endsWith(";")) return "cursor follows a completed statement";
  if (!options.allowCompleteStatement && isCompleteSelectAtDocumentTail(state, pos)) {
    return "SQL statement is already complete";
  }
  return null;
}
