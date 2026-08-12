/**
 * 评测脚本共用的环境装配：endpoint 凭据、vault 连接、AiSettings。
 *
 * 产品里 API key 走 `safeStorage`（只有 Electron 主进程能解），脚本拿不到，
 * 所以评测统一从环境变量读，再用与产品相同的 `createTransportForProfile` 组
 * transport——这样测到的仍是真实的 provider 路径，只是绕开了密钥存储。
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import type { AiSettings, ConnectionEntry, ConnectionMap } from "@shared/types";

export interface EvalCredentials {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export type EvalConnection = { name: string; entry: ConnectionEntry } | null;

/** 缺任何一项都直接报错：别让一整轮跑完才发现 model 名写错。 */
export function requireCredentials(): EvalCredentials {
  const apiKey = process.env.STELA_EVAL_API_KEY?.trim() ?? "";
  const baseUrl = process.env.STELA_EVAL_BASE_URL?.trim() ?? "";
  const model = process.env.STELA_EVAL_MODEL?.trim() ?? "";
  if (!apiKey || !baseUrl || !model) {
    throw new Error(
      "set STELA_EVAL_API_KEY, STELA_EVAL_BASE_URL and STELA_EVAL_MODEL " +
        "(an OpenAI-compatible endpoint) before running this eval",
    );
  }
  return { apiKey, baseUrl, model };
}

/** 优先取带 schemaDir 的连接——没有 schemaDir 的话 schema 相关工具基本是空转。 */
export async function loadConnection(vaultPath: string): Promise<EvalConnection> {
  try {
    const raw = await fs.readFile(path.join(vaultPath, ".stela", "connections.json"), "utf-8");
    const parsed = JSON.parse(raw) as { entries?: ConnectionMap };
    const entries = Object.entries(parsed.entries ?? {});
    if (entries.length === 0) return null;
    const withSchemaDir = entries.find(([, entry]) => Boolean(entry.schemaDir));
    const [name, entry] = withSchemaDir ?? entries[0]!;
    return { name, entry };
  } catch {
    return null;
  }
}

export function buildEvalSettings(model: string, baseUrl: string): AiSettings {
  const profile = {
    id: "eval",
    name: "eval",
    vendorId: "custom",
    model,
    baseUrl,
    contextWindow: 128_000 as AiSettings["contextWindow"],
    hasApiKey: true,
  };
  return {
    providerMode: "custom",
    activeProfileId: profile.id,
    profiles: [profile],
    inlineCompletionEnabled: true,
    completionProfileId: profile.id,
    baseUrl,
    model,
    hasApiKey: true,
    contextWindow: profile.contextWindow,
    agentMaxIterations: 1,
    agentWallClockMs: 60_000,
    // 评测永不写库：mutation 一律在 proposal 环节拒掉。
    agentAllowMutations: false,
  } as AiSettings;
}

/** schemaDir 里的表名全集，来自 `db.table.md` 文件名。 */
export async function loadTableCatalog(connection: EvalConnection): Promise<string[]> {
  const dir = connection?.entry.schemaDir;
  if (!dir) return [];
  try {
    return (await fs.readdir(dir))
      .filter((file) => file.endsWith(".md"))
      .map((file) => file.slice(0, -3))
      .sort();
  } catch {
    return [];
  }
}
