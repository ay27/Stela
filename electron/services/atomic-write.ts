/**
 * 健壮的原子写文件。
 *
 * 背景：原来各 store 都用裸 `.tmp + rename` 做原子写，crash 安全没问题，但放在
 * 云同步 / 网络盘目录里会翻车。坚果云 / OneDrive / Dropbox / iCloud 这类同步客户端
 * 盯着目录扫描，可能在我们 `writeFile(tmp)` 与 `rename(tmp, fp)` 之间把 `.tmp`
 * 文件移走 / 删除 / 上锁，导致 rename 报：
 *   - ENOENT（源 .tmp 不见了，或目标目录被瞬时移走）
 *   - EPERM / EACCES / EBUSY（文件被同步客户端占用 / 锁定）
 *   - EXDEV（极少数同步实现把 tmp 落到别的挂载点）
 * 典型报错见坚果云 vault：`rename '.../settings.json.tmp' -> '.../settings.json'`。
 *
 * 容错策略：
 *   1) tmp 名带 pid + 时间 + 自增计数，唯一化，降低与并发写 / 同步客户端的碰撞；
 *   2) rename 失败时重试若干次（每次重建目录，应对目录被瞬时移走）；
 *   3) 仍失败则兜底「直接写目标文件」——牺牲原子性换可用性。对小体积 JSON 配置而言
 *      这点风险可接受（最坏情况是 crash 撞上这一瞬间留个半文件，下次启动走 defaults）。
 */

import { promises as fs } from "node:fs";
import path from "node:path";

const MAX_ATTEMPTS = 3;

let counter = 0;

export async function atomicWriteFile(
  fp: string,
  data: string | Uint8Array,
): Promise<void> {
  const dir = path.dirname(fp);
  await fs.mkdir(dir, { recursive: true });

  const tmp = path.join(
    dir,
    `.${path.basename(fp)}.${process.pid}.${Date.now().toString(36)}.${(counter++).toString(36)}.tmp`,
  );

  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      await fs.writeFile(tmp, data);
      await fs.rename(tmp, fp);
      return;
    } catch (err) {
      lastErr = err;
      // 失败路径清理可能残留的 tmp（rename 成功时 tmp 已不存在，不会走到这）。
      await fs.rm(tmp, { force: true }).catch(() => {});
      // 目录可能被同步客户端瞬时移走，重建后再试。
      await fs.mkdir(dir, { recursive: true }).catch(() => {});
    }
  }

  // 兜底：直接写目标文件（非原子）。云同步目录里这是最稳妥的可用性选择。
  try {
    await fs.writeFile(fp, data);
    return;
  } catch {
    throw lastErr;
  }
}
