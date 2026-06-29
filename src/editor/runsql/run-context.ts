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
  /** 当前文件名，作为 AI noteTitle 上下文。 */
  noteTitle?: string | null;
  /** 当前 Markdown 全文（含 frontmatter），优先使用 live buffer 而不是磁盘。 */
  noteMarkdown?: string | null;
}

export interface RunNoteContext {
  notePath: string;
  noteTitle: string;
  noteMarkdown: string;
}

let current: RunContext | null = null;

function noteTitleFromPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.split("/").pop() || path;
}

export function setRunContext(ctx: RunContext): void {
  current = {
    ...ctx,
    noteTitle: ctx.noteTitle ?? noteTitleFromPath(ctx.path),
  };
}

export function clearRunContext(path: string): void {
  if (current?.path === path) {
    current = null;
  }
}

export function getRunContext(): RunContext | null {
  return current;
}

export function updateRunContextNote(path: string, noteMarkdown: string): void {
  if (current?.path !== path) return;
  current = {
    ...current,
    noteTitle: current.noteTitle ?? noteTitleFromPath(path),
    noteMarkdown,
  };
}

export function getRunNoteContext(): RunNoteContext | null {
  if (!current?.noteMarkdown) return null;
  return {
    notePath: current.path,
    noteTitle: current.noteTitle ?? noteTitleFromPath(current.path),
    noteMarkdown: current.noteMarkdown,
  };
}
