/**
 * Git CLI 薄封装。
 *
 * 设计：
 *   - 所有 git 操作 shell out 到系统 `git`（不引入 libgit2 / isomorphic-git），
 *     与 tolaria 一致：尊重用户的 `.gitconfig`、SSH/HTTPS 凭据、GCM / Keychain。
 *   - macOS / Linux 下 GUI 启动的 Electron 进程 PATH 往往缺 `/usr/local/bin` 等，
 *     这里把常见 git 安装路径补进 PATH，避免 "git not found"。
 *   - 统一加 `-c core.quotePath=false`，让中文 / 非 ASCII 文件名在 porcelain /
 *     diff 输出里保持原样，不被转义成 `\xxx`。
 *   - 慢操作（pull / push / clone）由调用方在 main 进程里 await；better 的做法是
 *     worker_thread，但 execFile 本身是异步非阻塞 I/O，不会卡住 event loop。
 */

import { execFile } from "node:child_process";
import os from "node:os";

import { AppError } from "@shared/errors";
import { getLogger } from "../logger";

const log = getLogger("git");

/** 常见 git 可执行路径，补进 PATH 兜底 GUI 启动缺环境的情况。 */
const EXTRA_PATHS = [
  "/usr/local/bin",
  "/opt/homebrew/bin",
  "/usr/bin",
  "/bin",
];

function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const sep = process.platform === "win32" ? ";" : ":";
  const current = env.PATH ?? "";
  const parts = current.split(sep).filter(Boolean);
  for (const p of EXTRA_PATHS) {
    if (!parts.includes(p)) parts.push(p);
  }
  env.PATH = parts.join(sep);
  // 关掉交互式凭据弹窗 / 编辑器，避免 git 在子进程里挂起等待 stdin。
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_OPTIONAL_LOCKS = "0";
  // 任何会打开编辑器的子命令（merge / rebase --continue）都降级为 no-op，
  // 避免子进程挂起等待编辑器保存。提交信息一律通过 -m / --no-edit 提供。
  env.GIT_EDITOR = "true";
  env.GIT_SEQUENCE_EDITOR = "true";
  return env;
}

export interface GitRunOptions {
  /** 工作目录（一般是 vault 根）。clone 时可指向父目录。 */
  cwd: string;
  /** 允许的最大 stdout 字节数；大 diff / log 调用方可调高。默认 32MB。 */
  maxBuffer?: number;
  /** 视为"非致命"的退出码（如 `git diff --quiet` 的 1）；命中时不抛错。 */
  okExitCodes?: number[];
}

export interface GitRunResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * 运行一次 git 命令。失败（非 okExitCodes）抛 AppError(code="git_failed")。
 * stderr 会一并带进 message，方便 UI 展示 "fatal: ..." 之类原始信息。
 */
export function git(
  args: string[],
  opts: GitRunOptions,
): Promise<GitRunResult> {
  const finalArgs = ["-c", "core.quotePath=false", ...args];
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      finalArgs,
      {
        cwd: opts.cwd,
        env: gitEnv(),
        maxBuffer: opts.maxBuffer ?? 32 * 1024 * 1024,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        const out = stdout?.toString() ?? "";
        const errOut = stderr?.toString() ?? "";
        if (!err) {
          resolve({ stdout: out, stderr: errOut, code: 0 });
          return;
        }
        const code = typeof (err as { code?: unknown }).code === "number"
          ? ((err as { code: number }).code)
          : 1;
        if (opts.okExitCodes?.includes(code)) {
          resolve({ stdout: out, stderr: errOut, code });
          return;
        }
        // ENOENT → git 不在 PATH 上
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          reject(
            new AppError(
              "git_not_found",
              "git executable not found. Install git (macOS: xcode-select --install; Windows: Git for Windows).",
            ),
          );
          return;
        }
        const detail = errOut.trim() || out.trim() || err.message;
        log.warn(`git ${args[0]} failed (${code}): ${detail}`);
        reject(new AppError("git_failed", detail));
      },
    );
  });
}

/** 跑一条 git 命令，仅取 trimmed stdout。 */
export async function gitOut(
  args: string[],
  opts: GitRunOptions,
): Promise<string> {
  const r = await git(args, opts);
  return r.stdout.trim();
}

/** 把多行 stdout 拆成非空行数组。 */
export function splitLines(s: string): string[] {
  return s
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter((l) => l.length > 0);
}

/** tmpdir 暴露给 clone 等需要落临时目录的模块。 */
export function tmpDir(): string {
  return os.tmpdir();
}
