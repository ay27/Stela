/**
 * runsql markdown fence 的解析 / detail 补丁。
 *
 * 规范实现已抽到 [`@shared/runsql-fences`](../../../electron/shared/runsql-fences.ts)，
 * 供 main 进程的 SQL 索引服务复用同一份 fence 解析逻辑；本文件只做重导出，保留
 * 既有导入路径（`@/editor/runsql/markdown-patch`）不破坏调用方。
 */
export type {
  RunsqlFenceInfo,
  PatchRunsqlDetailOptions,
} from "@shared/runsql-fences";
export { parseRunsqlFences, patchRunsqlDetail } from "@shared/runsql-fences";
