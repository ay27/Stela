/**
 * 解析跨进程 IPC 错误 code。
 *
 * 背景：main 端 (`electron/main/ipc-router.ts`) throw 的 Error 在过 Electron
 * structured clone 之后，自定义属性（`code` / `retryable`）会丢失，renderer
 * 端拿到的只剩 `name` 和 `message`。为了让 renderer 仍能据 code 做分支
 * （例如 `no_vault` 静默兜底、`retryable` 不弹错误 toast），main 端把 code
 * 编码到 message 前缀里：`[code] message`。
 *
 * 本 helper 同时兼容两种来源：
 *   1. 同进程错误对象（带 `code`）—— 直接读；
 *   2. 跨进程 IPC 错误 —— 从 message 解析 `[code] ` 前缀。
 *
 * 使用建议：
 *   - 业务代码请用 `getIpcErrorCode(err) === "no_vault"` 之类的语义比较，
 *     不要直接 `(err as any).code === "..."`。
 */

const CODE_PREFIX = /^\[([a-z0-9_]+)\]\s/i;

export function getIpcErrorCode(err: unknown): string | null {
  if (!err || typeof err !== "object") return null;
  const anyE = err as { code?: unknown; message?: unknown };
  if (typeof anyE.code === "string" && anyE.code.length > 0) {
    return anyE.code;
  }
  if (typeof anyE.message === "string") {
    const m = CODE_PREFIX.exec(anyE.message);
    if (m) return m[1];
  }
  return null;
}

/**
 * 判断是否为 retryable 错误。同样三层兜底：实例属性 → message 标记 → false。
 *
 * 注：当前 main 端没有把 retryable 编进 message（避免 UI 把内部标志位露给用户），
 * 所以跨进程后只能通过 code 反推或失去这个信号。如果将来需要严格保留
 * retryable，再扩展 main 端的 message 编码格式。
 */
export function isIpcRetryable(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  return (err as { retryable?: unknown }).retryable === true;
}
