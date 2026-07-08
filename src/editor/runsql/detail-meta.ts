/**
 * `<detail>` HTML 块的解析与序列化。
 *
 * 规范实现已抽到 [`@shared/detail-meta`](../../../electron/shared/detail-meta.ts)，
 * 供 main 进程的 SQL 索引服务（读 `run-date`）与 renderer 共用；本文件只做
 * 重导出，保留既有导入路径（`@/editor/runsql/detail-meta`）不破坏调用方。
 */
export type { DetailMeta } from "@shared/detail-meta";
export { matchDetail, parseDetail, serializeDetail } from "@shared/detail-meta";
