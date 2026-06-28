/**
 * 连接配置 CRUD（Electron 适配）。
 *
 * 走 main 进程 `electron/services/connections-store.ts`，文件落 `{userData}/stela-connections.json`。
 *
 * **凭据安全**：`password` 字段在 main 端写盘前会经 Electron `safeStorage`
 * 加密为 `__enc:` 前缀的 base64；不可加密时退化为 `__plain:` 前缀，UI 会显示
 * banner（见 [services/privacy.ts](./privacy.ts) 与 SecurityTab）。renderer 收到的
 * `entry.config.password` 永远是明文，无需手动解密。
 */

import { getIpcErrorCode } from "@/lib/ipc-error";

export interface ConnectionEntry {
  kind: string;
  config: unknown;
  /** 同步表结构到 Markdown 的目标目录 */
  schemaDir?: string;
}

export type ConnectionMap = Record<string, ConnectionEntry>;

/**
 * 返回按名称升序排序后的第一个连接名；无连接时返回 null。
 *
 * 用于文件 frontmatter 未指定 `connection_name` 时的默认兜底：新开的 / 老的 markdown
 * 笔记直接拿第一个已保存连接，省掉手动选一次的步骤。Picker 和 RunContext 共用
 * 这一规则，保证展示态和执行态一致。
 */
export function firstConnectionName(entries: ConnectionMap): string | null {
  for (const name of Object.keys(entries).sort()) {
    return name;
  }
  return null;
}

function isNoVault(err: unknown): boolean {
  return getIpcErrorCode(err) === "no_vault";
}

export async function loadConnections(): Promise<ConnectionMap> {
  try {
    return await window.stela.connections.load();
  } catch (err) {
    // 没打开 vault 时返回空 map，让调用方按"还没连接"处理；不污染 UI
    if (isNoVault(err)) return {};
    throw err;
  }
}

export async function upsertConnection(
  name: string,
  entry: ConnectionEntry,
): Promise<ConnectionMap> {
  return window.stela.connections.upsert(name, entry);
}

export async function removeConnection(name: string): Promise<ConnectionMap> {
  return window.stela.connections.remove(name);
}
