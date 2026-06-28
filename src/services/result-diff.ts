/**
 * 结果集行级 diff 引擎（renderer 纯函数，可单测，无 DOM / IPC 依赖）。
 *
 * 用于 RunSQL block 的「比对」模式：把同一个 block 的两次执行（基线 = 较旧，
 * 当前 = 较新）按行对齐，标出新增 / 删除行与变更单元格。
 *
 * 行对齐策略（见 computeResultDiff）：
 *   1. 用户指定 keyColumns → 复合主键对齐
 *   2. 否则自动推断：两侧都 ≥2 行时，找一列唯一率 > 0.95 的列作 key
 *   3. 推断失败 / 单行 → 按行号对齐（典型：单行聚合监控 SQL）
 *
 * schema 漂移（列名集合不一致）时 schemaMatch=false，仍按列名并集渲染，
 * 仅一侧存在的列整列标 added / removed。
 */

import type { ColumnDef } from "@/contracts";

export type CellDiffStatus = "same" | "changed" | "added" | "removed";

export interface DiffColumn {
  name: string;
  typeName: string;
  /** 该列在基线结果里存在 */
  inLeft: boolean;
  /** 该列在当前结果里存在 */
  inRight: boolean;
}

export interface DiffRow {
  kind: "matched" | "added" | "removed";
  /** 稳定行标识：keyed 时为复合 key 字符串，index 对齐时为 `#<idx>` */
  key: string;
  /** 基线行（removed / matched 有值；added 为 null） */
  left: unknown[] | null;
  /** 当前行（added / matched 有值；removed 为 null） */
  right: unknown[] | null;
  /** 按 unified columns 顺序的逐单元格状态 */
  cells: CellDiffStatus[];
}

export interface ResultDiff {
  /** 两侧列名集合（含顺序）是否完全一致 */
  schemaMatch: boolean;
  /** 渲染用并集列（右优先，左独有列追加在后） */
  columns: DiffColumn[];
  leftColumns: ColumnDef[];
  rightColumns: ColumnDef[];
  /** 实际用于对齐的 key 列名；空数组 = 按行号对齐 */
  keyColumns: string[];
  rows: DiffRow[];
  stats: {
    added: number;
    removed: number;
    /** 至少有一个单元格变更的 matched 行数 */
    changed: number;
    /** 变更单元格总数 */
    changedCells: number;
  };
}

export interface DiffInput {
  columns: ColumnDef[];
  rows: unknown[][];
}

export interface ComputeDiffOptions {
  /** 指定对齐 key 列名；null / 省略 = 自动推断 */
  keyColumns?: string[] | null;
  /** 各侧最多参与 diff 的行数，默认 500 */
  rowCap?: number;
}

export const DIFF_ROW_CAP = 500;

/** 单元格值归一化：null/undefined → null，对象 → JSON，其余 → String。 */
function normalizeCell(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function cellEqual(a: unknown, b: unknown): boolean {
  return normalizeCell(a) === normalizeCell(b);
}

function buildColIndex(columns: ColumnDef[]): Map<string, number> {
  const m = new Map<string, number>();
  columns.forEach((c, i) => {
    if (!m.has(c.name)) m.set(c.name, i);
  });
  return m;
}

/** 并集列：右列优先（保序），左独有列追加在末尾。 */
function buildUnifiedColumns(
  leftColumns: ColumnDef[],
  rightColumns: ColumnDef[],
): DiffColumn[] {
  const leftNames = new Set(leftColumns.map((c) => c.name));
  const rightNames = new Set(rightColumns.map((c) => c.name));
  const out: DiffColumn[] = [];
  const seen = new Set<string>();
  for (const c of rightColumns) {
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    out.push({
      name: c.name,
      typeName: c.typeName,
      inLeft: leftNames.has(c.name),
      inRight: true,
    });
  }
  for (const c of leftColumns) {
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    out.push({
      name: c.name,
      typeName: c.typeName,
      inLeft: true,
      inRight: rightNames.has(c.name),
    });
  }
  return out;
}

function schemaIdentical(a: ColumnDef[], b: ColumnDef[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((c, i) => c.name === b[i].name);
}

/**
 * 自动推断 key 列：两侧都 ≥2 行时，找第一列在两侧唯一率都 > 0.95 的列。
 * 找不到返回 []（调用方退化为行号对齐）。
 */
function inferKeyColumns(left: DiffInput, right: DiffInput): string[] {
  if (left.rows.length < 2 || right.rows.length < 2) return [];
  const leftIdx = buildColIndex(left.columns);
  const rightIdx = buildColIndex(right.columns);
  const uniqueRatio = (rows: unknown[][], colIdx: number): number => {
    if (rows.length === 0) return 0;
    const seen = new Set<string>();
    for (const row of rows) {
      const norm = normalizeCell(row[colIdx]);
      // null 视为不可作 key
      if (norm === null) return 0;
      seen.add(norm);
    }
    return seen.size / rows.length;
  };
  for (const col of right.columns) {
    const li = leftIdx.get(col.name);
    const ri = rightIdx.get(col.name);
    if (li === undefined || ri === undefined) continue;
    if (uniqueRatio(left.rows, li) > 0.95 && uniqueRatio(right.rows, ri) > 0.95) {
      return [col.name];
    }
  }
  return [];
}

function rowKey(
  row: unknown[],
  keyColIndices: number[],
): string {
  return JSON.stringify(keyColIndices.map((i) => normalizeCell(row[i])));
}

/** 计算 matched 行的逐单元格状态（按 unified columns 顺序）。 */
function diffCells(
  left: unknown[],
  right: unknown[],
  unified: DiffColumn[],
  leftIdx: Map<string, number>,
  rightIdx: Map<string, number>,
): { cells: CellDiffStatus[]; changedCount: number } {
  const cells: CellDiffStatus[] = [];
  let changedCount = 0;
  for (const col of unified) {
    if (col.inLeft && col.inRight) {
      const lv = left[leftIdx.get(col.name)!];
      const rv = right[rightIdx.get(col.name)!];
      if (cellEqual(lv, rv)) {
        cells.push("same");
      } else {
        cells.push("changed");
        changedCount++;
      }
    } else if (col.inRight) {
      cells.push("added");
      changedCount++;
    } else {
      cells.push("removed");
      changedCount++;
    }
  }
  return { cells, changedCount };
}

/**
 * 计算两次结果集的 diff。left = 基线（较旧），right = 当前（较新）。
 */
export function computeResultDiff(
  left: DiffInput,
  right: DiffInput,
  options: ComputeDiffOptions = {},
): ResultDiff {
  const rowCap = options.rowCap ?? DIFF_ROW_CAP;
  const leftRows = left.rows.slice(0, rowCap);
  const rightRows = right.rows.slice(0, rowCap);

  const unified = buildUnifiedColumns(left.columns, right.columns);
  const leftIdx = buildColIndex(left.columns);
  const rightIdx = buildColIndex(right.columns);
  const schemaMatch = schemaIdentical(left.columns, right.columns);

  // 解析 key 列
  let keyColumns: string[] = [];
  if (options.keyColumns && options.keyColumns.length > 0) {
    keyColumns = options.keyColumns.filter(
      (name) => leftIdx.has(name) && rightIdx.has(name),
    );
  }
  if (keyColumns.length === 0 && !options.keyColumns) {
    keyColumns = inferKeyColumns(
      { columns: left.columns, rows: leftRows },
      { columns: right.columns, rows: rightRows },
    );
  }

  const rows: DiffRow[] = [];
  let added = 0;
  let removed = 0;
  let changed = 0;
  let changedCells = 0;

  if (keyColumns.length > 0) {
    const leftKeyIdx = keyColumns.map((n) => leftIdx.get(n)!);
    const rightKeyIdx = keyColumns.map((n) => rightIdx.get(n)!);
    const leftMap = new Map<string, unknown[]>();
    for (const row of leftRows) {
      leftMap.set(rowKey(row, leftKeyIdx), row);
    }
    const consumedLeft = new Set<string>();
    // 先按当前（right）顺序产出 matched / added
    for (const rRow of rightRows) {
      const key = rowKey(rRow, rightKeyIdx);
      const lRow = leftMap.get(key);
      if (lRow) {
        consumedLeft.add(key);
        const { cells, changedCount } = diffCells(
          lRow,
          rRow,
          unified,
          leftIdx,
          rightIdx,
        );
        if (changedCount > 0) {
          changed++;
          changedCells += changedCount;
        }
        rows.push({ kind: "matched", key, left: lRow, right: rRow, cells });
      } else {
        added++;
        rows.push({
          kind: "added",
          key,
          left: null,
          right: rRow,
          cells: unified.map(() => "added"),
        });
      }
    }
    // 末尾追加只在基线里出现的 removed 行
    for (const lRow of leftRows) {
      const key = rowKey(lRow, leftKeyIdx);
      if (consumedLeft.has(key)) continue;
      removed++;
      rows.push({
        kind: "removed",
        key,
        left: lRow,
        right: null,
        cells: unified.map(() => "removed"),
      });
    }
  } else {
    // 行号对齐
    const n = Math.max(leftRows.length, rightRows.length);
    for (let i = 0; i < n; i++) {
      const lRow = leftRows[i];
      const rRow = rightRows[i];
      const key = `#${i}`;
      if (lRow && rRow) {
        const { cells, changedCount } = diffCells(
          lRow,
          rRow,
          unified,
          leftIdx,
          rightIdx,
        );
        if (changedCount > 0) {
          changed++;
          changedCells += changedCount;
        }
        rows.push({ kind: "matched", key, left: lRow, right: rRow, cells });
      } else if (rRow) {
        added++;
        rows.push({
          kind: "added",
          key,
          left: null,
          right: rRow,
          cells: unified.map(() => "added"),
        });
      } else {
        removed++;
        rows.push({
          kind: "removed",
          key,
          left: lRow ?? null,
          right: null,
          cells: unified.map(() => "removed"),
        });
      }
    }
  }

  return {
    schemaMatch,
    columns: unified,
    leftColumns: left.columns,
    rightColumns: right.columns,
    keyColumns,
    rows,
    stats: { added, removed, changed, changedCells },
  };
}

/** 给定 unified column，取某行该列的值（按 left/right 各自索引）。 */
export function cellValue(
  row: unknown[] | null,
  column: DiffColumn,
  side: "left" | "right",
  leftColumns: ColumnDef[],
  rightColumns: ColumnDef[],
): unknown {
  if (!row) return null;
  const cols = side === "left" ? leftColumns : rightColumns;
  const present = side === "left" ? column.inLeft : column.inRight;
  if (!present) return null;
  const idx = cols.findIndex((c) => c.name === column.name);
  return idx >= 0 ? row[idx] : null;
}
