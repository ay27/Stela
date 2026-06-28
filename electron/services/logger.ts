/**
 * Main 进程统一日志。
 *
 * Phase 6 实现：console-only，prefix 标识来源。
 * Phase 7 应该接 electron-log 或自定义 file sink，写到 `{userData}/logs/main.log`，
 * 并按大小轮转。当前仅作为统一入口，方便后续无侵入升级。
 *
 * TODO(stub Phase 7):
 *   - file sink + 滚动
 *   - 异常上报到 main 错误对话框（非阻塞）
 *   - 敏感字段脱敏（password / token / sessionId）
 */

type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const ENV_LEVEL = (process.env.STELA_LOG_LEVEL as Level | undefined) ?? "info";
const MIN_LEVEL = LEVELS[ENV_LEVEL] ?? LEVELS.info;

function emit(level: Level, scope: string, args: unknown[]): void {
  if (LEVELS[level] < MIN_LEVEL) return;
  const ts = new Date().toISOString();
  const prefix = `[stela][${level}][${scope}]`;
  if (level === "error") {
    console.error(ts, prefix, ...args);
  } else if (level === "warn") {
    console.warn(ts, prefix, ...args);
  } else {
    console.log(ts, prefix, ...args);
  }
}

export interface Logger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export function getLogger(scope: string): Logger {
  return {
    debug: (...a) => emit("debug", scope, a),
    info: (...a) => emit("info", scope, a),
    warn: (...a) => emit("warn", scope, a),
    error: (...a) => emit("error", scope, a),
  };
}

export const log = getLogger("main");
