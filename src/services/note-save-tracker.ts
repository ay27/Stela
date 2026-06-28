/**
 * 各 note 路径在 renderer 侧「最后一次已知磁盘内容」快照。
 *
 * 用途：vault watcher 推送 changed 且 tab 仍 dirty 时，先 readFile 一次，
 * 若 disk === lastKnownDisk 则视为自写回声（用户 buffer 可能更新），不弹冲突 banner。
 *
 * 更新时机：EditorView 初始读盘、writeFile 成功。不在 watcher 热路径做 I/O。
 */

interface DiskSnapshot {
  content: string;
  at: number;
}

const snapshots = new Map<string, DiskSnapshot>();

/** 记录该路径当前已知的磁盘全文（含 frontmatter）。 */
export function setKnownDiskContent(path: string, content: string): void {
  snapshots.set(path, { content, at: Date.now() });
}

export function getKnownDiskContent(path: string): string | undefined {
  return snapshots.get(path)?.content;
}

/** 移除路径快照（tab 关闭 / vault 切换时可调用；非必须）。 */
export function clearKnownDiskContent(path: string): void {
  snapshots.delete(path);
}
