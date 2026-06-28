/**
 * 跨进程错误归一化。
 *
 * 设计：
 * - main 端任何异常都先包成 `AppError`，再 throw 给 IPC 框架；
 *   electron 默认会把 Error 序列化为 `Error: <message>`，丢失 code/retryable 信息。
 * - main IPC 包装层捕获异常 → 转成 `IpcErrorPayload` plain 对象，作为 invoke 的
 *   reject 值返回 renderer。renderer 收到的就是 `{ code, message, retryable }`。
 */

import type { IpcErrorPayload } from "./types";

export class AppError extends Error implements IpcErrorPayload {
  constructor(
    public code: string,
    message: string,
    public retryable: boolean = false,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}

/**
 * 鸭子类型识别「AppError-like」错误：带 string `code` 的 Error。
 *
 * 必须用结构判断而非 `instanceof`：module 插件被单独打包，其 `PluginError` /
 * `AppError` 是**另一个类实例**，`instanceof AppError` 恒为 false，会丢掉 code。
 * 只要对象有 string `code`（且是 Error），就按 `{ code, message, retryable }` 归一化。
 */
function asErrorLikeWithCode(
  e: unknown,
): { code: string; message: string; retryable: boolean } | null {
  if (!(e instanceof Error)) return null;
  const code = (e as { code?: unknown }).code;
  if (typeof code !== "string" || code.length === 0) return null;
  // Node fs/errno 错误（带 errno / syscall）保持原有 classifyError 行为（小写化），
  // 不在这里拦截，避免回归。只接管「自定义 string code」的应用 / 插件错误。
  const errno = (e as { errno?: unknown }).errno;
  const syscall = (e as { syscall?: unknown }).syscall;
  if (typeof errno === "number" || typeof syscall === "string") return null;
  const retryable = (e as { retryable?: unknown }).retryable;
  return {
    code,
    message: e.message || String(e),
    retryable: retryable === true,
  };
}

export function toIpcError(e: unknown): IpcErrorPayload {
  if (isAppError(e)) {
    return { code: e.code, message: e.message, retryable: e.retryable };
  }
  // 跨打包边界的插件错误（PluginError / 插件自带 AppError）走鸭子类型归一化
  const errLike = asErrorLikeWithCode(e);
  if (errLike) {
    return errLike;
  }
  if (e instanceof Error) {
    return {
      code: classifyError(e),
      message: e.message || String(e),
      retryable: false,
    };
  }
  return { code: "unknown", message: String(e), retryable: false };
}

function classifyError(e: Error): string {
  // node fs 常见错误前缀映射
  const code = (e as NodeJS.ErrnoException).code;
  if (code) return code.toLowerCase();
  return "unknown";
}
