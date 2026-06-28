/**
 * IStorage 实现（Electron 适配）。
 *
 * Renderer 不持有 Node 权限，所有存储能力都通过 preload 暴露的
 * `window.stela.storage` typed bridge 进入 main 进程。
 */

import type {
  ColumnDef,
  IStorage,
  ListRunsByBlockOptions,
  RowsPage,
  RunRecord,
} from "@/contracts";

/**
 * 单次 IPC 写入的最大行数。超过这个阈值 saveRows 会自动分块顺序调用，避免：
 *   1. 单次 ipcRenderer.invoke 的结构化克隆把几万行 array 一次性 copy 过 IPC，
 *      在 renderer / main 各产生一次 GC 尖峰
 *   2. main 进程 better-sqlite3 单事务里一次插入太多行（同步 API，事务期间
 *      block main loop）
 *
 * 5000 行是结合本地 dogfood 经验取的：单批 IPC 序列化在 50ms 内、单批事务在
 * 100ms 内；用户视觉上"渐进保存中"也比"长时间无响应再一次性出结果"友好。
 */
const SAVE_ROWS_CHUNK_SIZE = 5000;

/**
 * 当前正在进行的 storage.open 调用 promise。
 *
 * 解决一个 race condition：vault 初始化时 `vaultPath` 已设置但 `storage.open` 还没
 * resolve（main 端 better-sqlite3 打开 + WAL recovery + legacy 迁移可能耗时几十到
 * 几百 ms）。这期间如果用户点开有 RunSQL 块的文件，BlockResult 会立即调
 * `getSchema(runId)`，main 端报 "storage not opened"。
 *
 * 兜底策略：所有读写方法在 IPC 之前先 await 这个 promise（如果存在）。这样
 * `open` 还没完成时，调用会自动排队等待；切 vault 时 promise 被替换为新一次
 * open，旧的 in-flight 调用还是会等到 *最近一次* open 完成才放行 —— 由于 main
 * 端 `open(newPath)` 会先关闭旧连接、再打开新连接，最终的 `current.vaultPath`
 * 就是新 vault 路径，行为是合理的。
 *
 * 注意：调用方仍需保证 open 已被发起（`workspace.ts` 在 `setCurrent` 之后调
 * `electronStorage.open`）。本机制不替代显式 open。
 */
let openInFlight: Promise<void> | null = null;

async function awaitOpen(): Promise<void> {
  if (openInFlight) await openInFlight;
}

export const electronStorage: IStorage = {
  async open(vaultPath: string): Promise<void> {
    const p = window.stela.storage.open(vaultPath);
    openInFlight = p
      .catch(() => undefined)
      .then(() => undefined);
    await p;
  },
  async saveRun(record: RunRecord): Promise<void> {
    await awaitOpen();
    await window.stela.storage.saveRun(record);
  },
  async saveSchema(runId: string, columns: ColumnDef[]): Promise<void> {
    await awaitOpen();
    await window.stela.storage.saveSchema(runId, columns);
  },
  async saveRows(runId: string, rows: unknown[][]): Promise<void> {
    await awaitOpen();
    if (rows.length <= SAVE_ROWS_CHUNK_SIZE) {
      await window.stela.storage.saveRows(runId, rows);
      return;
    }
    for (let offset = 0; offset < rows.length; offset += SAVE_ROWS_CHUNK_SIZE) {
      const batch = rows.slice(offset, offset + SAVE_ROWS_CHUNK_SIZE);
      await window.stela.storage.saveRows(runId, batch, offset);
    }
  },
  async queryPage(
    runId: string,
    offset: number,
    limit: number,
  ): Promise<RowsPage> {
    await awaitOpen();
    return window.stela.storage.queryPage(runId, offset, limit);
  },
  async getSchema(runId: string): Promise<ColumnDef[]> {
    await awaitOpen();
    return window.stela.storage.getSchema(runId);
  },
  async listRuns(): Promise<RunRecord[]> {
    await awaitOpen();
    return window.stela.storage.listRuns();
  },
  async listRunsByBlockId(
    blockId: string,
    options?: ListRunsByBlockOptions,
  ): Promise<RunRecord[]> {
    await awaitOpen();
    return window.stela.storage.listRunsByBlockId(blockId, options);
  },
  async cleanup(keepDays: number): Promise<number> {
    await awaitOpen();
    return window.stela.storage.cleanup(keepDays);
  },
};
