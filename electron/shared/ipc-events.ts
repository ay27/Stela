/**
 * 单向事件 channel（main → renderer 广播）。
 *
 * 与 `ipc-channels.ts` 中的 invoke channel 区分：
 *   - invoke channel 走 ipcMain.handle / ipcRenderer.invoke，双向 + zod 校验
 *   - event channel 走 webContents.send / ipcRenderer.on，单向 main 推送，
 *     payload 由 main 控制，renderer 端只读、不做 zod 校验
 *
 * 放在独立常量里是为了避免 `IPC_SCHEMAS: Record<IpcChannel, ...>` 强制要求
 * 每个 channel 都有 invoke schema 的约束，也避免 `assertAllRegistered` 把
 * "广播 channel 没有 invoke handler" 误报为漏注册。
 */

export const IPC_EVENTS = {
  /** vault watcher 检测到外部文件变更（v0.2 #7）。payload: VaultExternalChangePayload */
  VAULT_EXTERNAL_CHANGE: "vault:external-change",
  /** Vault index 增量更新（v0.3 双链 M2）。payload: void —— renderer 收到后失效缓存 / 重查 */
  INDEX_CHANGED: "index:changed",
} as const;

export type IpcEventChannel = (typeof IPC_EVENTS)[keyof typeof IPC_EVENTS];

/**
 * 一次外部文件变更通知里的单条事件。
 *
 *   - `added`：路径新建（文件或目录）
 *   - `removed`：路径被删（文件或目录；rename 会先 removed 再 added）
 *   - `changed`：仅文件 — 内容变更
 */
export type VaultFsEventType = "added" | "removed" | "changed";

export interface VaultFsEvent {
  type: VaultFsEventType;
  /** 绝对路径（与 listDir 返回的 FileNode.path 同形态） */
  path: string;
  isDir: boolean;
}

/**
 * vault:external-change 的 payload。watcher 会把 250ms 内同 vault 的多条事件
 * 合并成一个 batch 推过来，避免 renderer 在巨量重命名 / 拷贝时被 IPC 淹没。
 */
export interface VaultExternalChangePayload {
  /** 触发本批次事件时的 vault 根路径 */
  vaultPath: string;
  events: VaultFsEvent[];
}
