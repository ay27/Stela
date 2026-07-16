/**
 * Line-level LCS diff for unified +/- views (agent propose_edit, etc.).
 *
 * ponytail: O(n*m) DP; for huge notes fall back to prefix/suffix when n*m > 40k
 * (same ceiling as the RunSQL AI rewrite helper). Upgrade = Myers / npm `diff`.
 */

export type LineDiffOp =
  | { kind: "equal"; line: string }
  | { kind: "added"; line: string }
  | { kind: "removed"; line: string };

const LCS_CELL_CAP = 40_000;

export function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  return text.split(/\r?\n/);
}

export function diffLines(original: string[], proposed: string[]): LineDiffOp[] {
  if (original.length * proposed.length > LCS_CELL_CAP) {
    return diffLinesByPrefixSuffix(original, proposed);
  }
  const rows = original.length + 1;
  const cols = proposed.length + 1;
  const dp = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = original.length - 1; i >= 0; i -= 1) {
    for (let j = proposed.length - 1; j >= 0; j -= 1) {
      dp[i]![j] =
        original[i] === proposed[j]
          ? dp[i + 1]![j + 1]! + 1
          : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const ops: LineDiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < original.length && j < proposed.length) {
    if (original[i] === proposed[j]) {
      ops.push({ kind: "equal", line: original[i]! });
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ kind: "removed", line: original[i]! });
      i += 1;
    } else {
      ops.push({ kind: "added", line: proposed[j]! });
      j += 1;
    }
  }
  while (i < original.length) {
    ops.push({ kind: "removed", line: original[i]! });
    i += 1;
  }
  while (j < proposed.length) {
    ops.push({ kind: "added", line: proposed[j]! });
    j += 1;
  }
  return ops;
}

function diffLinesByPrefixSuffix(original: string[], proposed: string[]): LineDiffOp[] {
  let prefix = 0;
  while (
    prefix < original.length &&
    prefix < proposed.length &&
    original[prefix] === proposed[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < original.length - prefix &&
    suffix < proposed.length - prefix &&
    original[original.length - 1 - suffix] === proposed[proposed.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return [
    ...original.slice(0, prefix).map<LineDiffOp>((line) => ({ kind: "equal", line })),
    ...original
      .slice(prefix, original.length - suffix)
      .map<LineDiffOp>((line) => ({ kind: "removed", line })),
    ...proposed
      .slice(prefix, proposed.length - suffix)
      .map<LineDiffOp>((line) => ({ kind: "added", line })),
    ...original.slice(original.length - suffix).map<LineDiffOp>((line) => ({ kind: "equal", line })),
  ];
}

export type DiffSegment =
  | { type: "line"; op: LineDiffOp }
  | { type: "collapse"; id: number; ops: Array<Extract<LineDiffOp, { kind: "equal" }>> };

/** Keep `context` equal lines around each change; fold longer equal runs into collapsible segments. */
export function buildDiffSegments(ops: LineDiffOp[], context = 3): DiffSegment[] {
  if (ops.length === 0) return [];

  const nearChange = new Array<boolean>(ops.length).fill(false);
  const changeIndexes: number[] = [];
  for (let i = 0; i < ops.length; i += 1) {
    if (ops[i]!.kind !== "equal") changeIndexes.push(i);
  }
  if (changeIndexes.length === 0) {
    // No changes — one fold for the whole file so the card stays short.
    return [
      {
        type: "collapse",
        id: 0,
        ops: ops.map((op) => ({ kind: "equal" as const, line: op.line })),
      },
    ];
  }
  for (const idx of changeIndexes) {
    const from = Math.max(0, idx - context);
    const to = Math.min(ops.length - 1, idx + context);
    for (let i = from; i <= to; i += 1) nearChange[i] = true;
  }

  const segments: DiffSegment[] = [];
  let collapseId = 0;
  let i = 0;
  while (i < ops.length) {
    const op = ops[i]!;
    if (op.kind !== "equal" || nearChange[i]) {
      segments.push({ type: "line", op });
      i += 1;
      continue;
    }
    const folded: Array<Extract<LineDiffOp, { kind: "equal" }>> = [];
    while (i < ops.length && ops[i]!.kind === "equal" && !nearChange[i]) {
      folded.push({ kind: "equal", line: ops[i]!.line });
      i += 1;
    }
    segments.push({ type: "collapse", id: collapseId, ops: folded });
    collapseId += 1;
  }
  return segments;
}
