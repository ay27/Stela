/**
 * IPC 路由器：把 channel → handler 注册到 ipcMain.handle 并统一做：
 *   1. 输入校验（zod via parseInput）
 *   2. 错误归一化（toIpcError → reject 给 renderer）
 *   3. 失败日志（main 端打 console，错误 stack 不出 main）
 *
 * 所有 channel 名都来自 IPC 常量；这里禁止注册未在常量里登记的 channel。
 */

import { ipcMain } from "electron";

import { IPC, type IpcChannel } from "@shared/ipc-channels";
import { parseInput } from "@shared/ipc-schema";
import { toIpcError } from "@shared/errors";
import type { IpcErrorPayload } from "@shared/types";

import { getLogger } from "../services/logger";

export type IpcHandler<I, O> = (
  input: I,
  ctx: { event: Electron.IpcMainInvokeEvent },
) => Promise<O> | O;

const REGISTERED = new Set<IpcChannel>();
const ipcLog = getLogger("ipc");

/**
 * Slow-channel 阈值：超过这个毫秒数会打 warn，方便定位主进程长任务。
 * 默认 300ms；可通过 STELA_IPC_SLOW_MS 环境变量调整（dev 排查时调小、prod 调大）。
 *
 * 不做更细的 p50/p95 直方图——目前先抓"哪些 channel 偶发慢"就够用，真要做指标
 * 后续接 perf-hook 直方图即可。
 */
const SLOW_IPC_MS = (() => {
  const raw = process.env.STELA_IPC_SLOW_MS;
  if (!raw) return 300;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 300;
})();

/**
 * 预期内的状态错误码：renderer 都已静默兜底，main 端按 warn 记录避免噪音。
 *
 * 当前清单：
 *   - `no_vault`：启动期 settings/connections/plugins 抢跑 vault.setCurrent 时
 *     的状态错误。renderer 收到后走 DEFAULT 兜底。
 *   - `not_open`：storage 读类调用先于 storage.open 完成时（race），renderer 端
 *     `electronStorage` 已经维护 openInFlight 兜底。
 *
 * 新增需谨慎：只把"renderer 一定会处理 + 高频出现于正常生命周期"的码放进来，
 * 别把真正的 bug 信号也藏起来。
 */
const EXPECTED_CODES = new Set<string>(["no_vault", "not_open"]);

export function registerHandler<I, O>(
  channel: IpcChannel,
  handler: IpcHandler<I, O>,
): void {
  if (REGISTERED.has(channel)) {
    throw new Error(`IPC channel already registered: ${channel}`);
  }
  REGISTERED.add(channel);

  ipcMain.handle(channel, async (event, raw) => {
    const t0 = Date.now();
    try {
      const input = parseInput<I>(channel, raw);
      const result = await handler(input, { event });
      const dt = Date.now() - t0;
      if (dt >= SLOW_IPC_MS) {
        ipcLog.warn(`slow ${channel} ${dt}ms`);
      }
      return result;
    } catch (err) {
      const dt = Date.now() - t0;
      const payload = toIpcError(err);
      // 已知 retryable 错误 + 已知预期状态错误降级为 warn 避免噪音；其它仍按
      // error 记录。dt 一并打出，与 slow 警告共用一套查询线索。
      //
      // EXPECTED_CODES 列举的错误是"启动期 / 切 vault / 切窗口"等正常生命周期里
      // 必然短暂出现的预期错误码，renderer 都已有静默兜底（见 settings-store.ts /
      // connections.ts 的 isNoVault / fall-back 分支）。它们出现在 error 级会让
      // 真正的 bug 信号被噪音淹没。
      const isExpected = payload.retryable || EXPECTED_CODES.has(payload.code);
      const log = isExpected ? ipcLog.warn : ipcLog.error;
      log(
        `${channel} failed (${dt}ms): ${payload.code} ${payload.message}`,
      );
      /**
       * Electron 对 `ipcMain.handle` 里 throw plain object 的处理在 renderer 侧
       * 常会退化成 `[object Object]`；而 throw Error 时 structured clone 又只
       * 保留 `name` / `message`，自定义属性（code / retryable）会被丢弃。
       *
       * 这里采用三重保障让 renderer 能稳定拿到 code：
       *   1. message 前缀 `[<code>] ` —— 最关键，跨进程序列化必然保留；renderer
       *      端 helper（src/lib/ipc-error.ts）解析这个前缀。
       *   2. name 设为 `IpcError` —— 让 renderer 一眼区分 IPC 错误。
       *   3. 仍把 code / retryable 挂在实例上 —— 同进程内调试 / 未来某天 Electron
       *      改进序列化策略时仍可用。
       *
       * 兼容性：旧 renderer 只读 message 仍能看到完整信息，只是多了一段 `[code] `
       * 前缀；新 renderer 通过 helper 拿到结构化 code。
       */
      const ipcErr = new Error(
        `[${payload.code}] ${payload.message}`,
      ) as Error & IpcErrorPayload;
      ipcErr.name = "IpcError";
      ipcErr.code = payload.code;
      ipcErr.retryable = payload.retryable;
      throw ipcErr;
    }
  });
}

/** 卸载所有（仅在 app quit 时使用） */
export function unregisterAll(): void {
  for (const ch of REGISTERED) {
    ipcMain.removeHandler(ch);
  }
  REGISTERED.clear();
}

/** 检查是否所有 IPC 常量都被注册（dev 启动时校验） */
export function assertAllRegistered(): void {
  const missing: string[] = [];
  for (const key of Object.keys(IPC) as Array<keyof typeof IPC>) {
    const ch = IPC[key];
    if (!REGISTERED.has(ch)) missing.push(`${String(key)}=${ch}`);
  }
  if (missing.length > 0) {
    ipcLog.warn(`handlers missing: ${missing.join(", ")}`);
  }
}
