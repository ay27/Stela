/**
 * 编辑器滚动位置记忆。
 *
 * 背景：切换 tab 会 unmount 当前 `EditorView` 并 remount 新 tab（Workspace 用
 * `key={tab.id}`），编辑器滚动容器 `.stela-milkdown-host` 随之销毁重建，滚动位置
 * 丢失。多页面联动工作时需要反复滚动，体感很差。
 *
 * 方案：用一个模块级 Map（按文件 path 为 key）缓存最近的 scrollTop。不入 Zustand，
 * 避免高频 scroll 触发 React 渲染。tab 在缓存里以 path 区分（file tab 的 id 即
 * `file:${path}`，path 唯一）。缓存只在进程内存里存活，重启 / 关 vault 后不保留——
 * 滚动位置属于"会话级"状态，无需持久化到磁盘。
 */
const scrollByPath = new Map<string, number>();

export function rememberScroll(path: string, scrollTop: number): void {
  scrollByPath.set(path, scrollTop);
}

export function recallScroll(path: string): number | undefined {
  return scrollByPath.get(path);
}

export function forgetScroll(path: string): void {
  scrollByPath.delete(path);
}
