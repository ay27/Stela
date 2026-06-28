/**
 * RunSQL 块（原 Obsidian 插件中的 runsql 块；M2 内部曾命名为 RunCircle，M3 起统一为 RunSQL）
 * 相关类型。运行时类型由 codeblock-nodeview 内部消费；磁盘 round-trip 由
 * `editor/runsql/stela-codeblock-schema.ts` 与 `remark-detail-merge.ts` 配合完成。
 */
export interface DetailMeta {
  blockId?: string;
  runDate: string;
  elapsed: string;
  rowCount: number;
  firstRow: Record<string, unknown> | null;
  resultRefId: string;
}

/**
 * RunSQL 块的内存视图（不进 ProseMirror schema，仅用作执行链/UI 摘要的方便结构）。
 */
export interface RunSqlData {
  blockId: string;
  sql: string;
  detail: DetailMeta | null;
  /**
   * 原始 `<detail>...</detail>` 文本片段，保存文件时原样吐回，
   * 确保 round-trip 对 legacy 文件零丢失。M3 执行成功后会用 `serializeDetail`
   * 重写这段为新元数据。
   */
  detailRaw: string | null;
}

export function generateBlockId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `blk_${ts}_${rand}`;
}
