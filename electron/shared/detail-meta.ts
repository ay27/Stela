/**
 * `<detail>` HTML 块的解析与序列化。main / renderer 共用的规范实现——
 * `src/editor/runsql/detail-meta.ts` 直接重导出本模块，避免 round-trip 逻辑
 * 出现两份实现漂移。main 侧的 SQL 索引服务（`electron/services/sql-index.ts`）
 * 用它读出每个 runsql 块最近一次执行的 `run-date`。
 *
 * Stela 笔记（.md）里的 runsql 块永远紧跟一段如下结构的 HTML：
 *
 * ```html
 * <detail>
 *   <block-id>blk_xxx</block-id>          ← 可选
 *   <run-date>2026-04-03 12:23:34</run-date>
 *   <elapsed>12s</elapsed>
 *   <row-count>3000</row-count>
 *   <first-row>{ "id": "..." }</first-row>
 *   <result-ref-id>123213545</result-ref-id>
 * </detail>
 * ```
 */

export interface DetailMeta {
  blockId?: string;
  runDate: string;
  elapsed: string;
  rowCount: number;
  firstRow: Record<string, unknown> | null;
  resultRefId: string;
}

const DETAIL_RE = /<detail>([\s\S]*?)<\/detail>/i;

export function matchDetail(html: string): { full: string; inner: string } | null {
  const m = html.match(DETAIL_RE);
  if (!m) return null;
  return { full: m[0], inner: m[1] };
}

export function parseDetail(inner: string): DetailMeta {
  const tag = (name: string): string => {
    const m = inner.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
    return m ? m[1].trim() : "";
  };

  let firstRow: Record<string, unknown> | null = null;
  const fr = tag("first-row");
  if (fr) {
    try {
      const parsed = JSON.parse(fr);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        firstRow = parsed as Record<string, unknown>;
      }
    } catch {
      firstRow = null;
    }
  }

  const blockId = tag("block-id") || undefined;

  return {
    blockId,
    runDate: tag("run-date"),
    elapsed: tag("elapsed"),
    rowCount: parseInt(tag("row-count"), 10) || 0,
    firstRow,
    resultRefId: tag("result-ref-id"),
  };
}

export function serializeDetail(d: DetailMeta): string {
  const fr = d.firstRow !== null ? JSON.stringify(d.firstRow) : "null";
  const lines = ["<detail>"];
  if (d.blockId) lines.push(`   <block-id>${d.blockId}</block-id>`);
  lines.push(
    `   <run-date>${d.runDate}</run-date>`,
    `   <elapsed>${d.elapsed}</elapsed>`,
    `   <row-count>${d.rowCount}</row-count>`,
    `   <first-row>${fr}</first-row>`,
    `   <result-ref-id>${d.resultRefId}</result-ref-id>`,
    "</detail>",
  );
  return lines.join("\n");
}
