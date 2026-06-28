/**
 * 当前活跃编辑器的执行上下文（module-level singleton）。
 *
 * NodeView 在执行 RunSQL 时通过 `getRunContext()` 拿到当前文档对应的
 * `connectionName`（来自 frontmatter）。同一时间只有一个 active editor，
 * 所以单例可行；MilkdownEditor 在 mount/unmount 时负责 set/clear。
 *
 * 这里刻意不上 zustand，省一次 React 订阅；`requestRefresh` 只用于让
 * 已挂载的 NodeView 即时更新 footer / button 状态（M3 暂用不到，预留 hook）。
 */

export interface RunContext {
  /** 完整文件路径，用于 storage 关联与多 tab 区分 */
  path: string;
  /** frontmatter.connection_name；可能为 null（未配置） */
  connectionName: string | null;
}

let current: RunContext | null = null;

export function setRunContext(ctx: RunContext): void {
  current = ctx;
}

export function clearRunContext(path: string): void {
  if (current?.path === path) {
    current = null;
  }
}

export function getRunContext(): RunContext | null {
  return current;
}
