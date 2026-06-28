/**
 * connections-store 单测（per-device secret shard 模型）。
 *
 * 纯 Node（tsx）即可跑：此环境无 electron safeStorage，secrets.encryptToken 退化为
 * `__plain:` 前缀，decryptToken 去前缀，行为确定，便于断言。
 *
 * 覆盖：
 *   - 保存时 secret 进 secrets_<slug>.json，共享 connections.json 不含 secret；
 *   - load 合并共享 config + 本设备 secret；
 *   - 提交空 secret 不覆盖 shard 已有值；
 *   - 旧式 inline secret 迁移进当前设备 shard 并从共享文件剥离；
 *   - 另一 slug 的 shard 不被当前设备读取/修改。
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  loadConnections,
  removeConnection,
  upsertConnection,
} from "./connections-store";

const SLUG = "macbook";

interface Check {
  name: string;
  pass: boolean;
  details?: string;
}

function expect(name: string, pass: boolean, details?: string): Check {
  return { name, pass, details };
}

async function withTempVault<T>(fn: (vaultPath: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "stela-connections-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function seedFile(
  vaultPath: string,
  relParts: string[],
  contents: unknown,
): Promise<void> {
  const fp = path.join(vaultPath, ".stela", ...relParts);
  await mkdir(path.dirname(fp), { recursive: true });
  await writeFile(fp, JSON.stringify(contents, null, 2), "utf-8");
}

async function readSharedConfig(
  vaultPath: string,
): Promise<Record<string, { kind: string; config: Record<string, unknown>; schemaDir?: string }>> {
  const raw = JSON.parse(
    await readFile(path.join(vaultPath, ".stela", "connections.json"), "utf-8"),
  ) as { entries?: Record<string, { kind: string; config: Record<string, unknown>; schemaDir?: string }> };
  return raw.entries ?? {};
}

async function readShard(
  vaultPath: string,
  slug: string,
): Promise<Record<string, Record<string, string>>> {
  try {
    const raw = JSON.parse(
      await readFile(
        path.join(vaultPath, ".stela", "secrets", `secrets_${slug}.json`),
        "utf-8",
      ),
    ) as { entries?: Record<string, Record<string, string>> };
    return raw.entries ?? {};
  } catch {
    return {};
  }
}

async function testUpsertSplitsSecretIntoShard(): Promise<Check[]> {
  return withTempVault(async (vaultPath) => {
    await upsertConnection(vaultPath, SLUG, "SR", {
      kind: "http",
      config: { conn_id: 80, authorization: "sk-live-token" },
      schemaDir: "/tmp/schema",
    });

    const shared = await readSharedConfig(vaultPath);
    const shard = await readShard(vaultPath, SLUG);

    return [
      expect(
        "shared connections.json keeps non-secret config",
        shared.SR?.config.conn_id === 80 && shared.SR?.schemaDir === "/tmp/schema",
      ),
      expect(
        "shared connections.json does NOT contain secret",
        !("authorization" in (shared.SR?.config ?? {})),
        `actual=${JSON.stringify(shared.SR?.config)}`,
      ),
      expect(
        "secret stored (wrapped) in device shard",
        shard.SR?.authorization === "__plain:sk-live-token",
        `actual=${String(shard.SR?.authorization)}`,
      ),
    ];
  });
}

async function testLoadMergesSharedAndShard(): Promise<Check[]> {
  return withTempVault(async (vaultPath) => {
    await upsertConnection(vaultPath, SLUG, "SR", {
      kind: "http",
      config: { conn_id: 80, authorization: "sk-live-token" },
    });

    const loaded = await loadConnections(vaultPath, SLUG);
    const cfg = loaded.SR?.config as Record<string, unknown> | undefined;

    return [
      expect("merged config has conn_id", cfg?.conn_id === 80),
      expect(
        "merged config has decrypted authorization",
        cfg?.authorization === "sk-live-token",
        `actual=${String(cfg?.authorization)}`,
      ),
    ];
  });
}

async function testBlankSecretDoesNotOverwriteShard(): Promise<Check[]> {
  return withTempVault(async (vaultPath) => {
    await upsertConnection(vaultPath, SLUG, "SR", {
      kind: "http",
      config: { conn_id: 80, authorization: "sk-live-token" },
    });
    // 第二次保存提交空 authorization（典型：表单密钥框被清空 / 解密失败回填空）。
    await upsertConnection(vaultPath, SLUG, "SR", {
      kind: "http",
      config: { conn_id: 81, authorization: "" },
    });

    const shard = await readShard(vaultPath, SLUG);
    const loaded = await loadConnections(vaultPath, SLUG);
    const cfg = loaded.SR?.config as Record<string, unknown> | undefined;

    return [
      expect(
        "shard still holds the original wrapped secret",
        shard.SR?.authorization === "__plain:sk-live-token",
        `actual=${String(shard.SR?.authorization)}`,
      ),
      expect("non-secret field still updates (conn_id=81)", cfg?.conn_id === 81),
      expect(
        "load returns preserved secret",
        cfg?.authorization === "sk-live-token",
      ),
    ];
  });
}

async function testLegacyInlineSecretMigratesToShard(): Promise<Check[]> {
  return withTempVault(async (vaultPath) => {
    // 旧机器级格式：secret 直接落在共享 connections.json 的 config 里（wrapped）。
    await seedFile(vaultPath, ["connections.json"], {
      entries: {
        SR: {
          kind: "http",
          config: { conn_id: 80, authorization: "__plain:legacy-token" },
          schemaDir: "/tmp/schema",
        },
      },
    });

    const loaded = await loadConnections(vaultPath, SLUG);
    const cfg = loaded.SR?.config as Record<string, unknown> | undefined;
    const shared = await readSharedConfig(vaultPath);
    const shard = await readShard(vaultPath, SLUG);

    return [
      expect(
        "legacy secret stripped from shared connections.json",
        !("authorization" in (shared.SR?.config ?? {})),
        `actual=${JSON.stringify(shared.SR?.config)}`,
      ),
      expect(
        "legacy secret migrated into device shard",
        shard.SR?.authorization === "__plain:legacy-token",
        `actual=${String(shard.SR?.authorization)}`,
      ),
      expect(
        "load still returns decrypted legacy secret",
        cfg?.authorization === "legacy-token",
      ),
    ];
  });
}

async function testOtherDeviceShardNotReadOrModified(): Promise<Check[]> {
  return withTempVault(async (vaultPath) => {
    await seedFile(vaultPath, ["connections.json"], {
      entries: {
        SR: { kind: "http", config: { conn_id: 80 } },
      },
    });
    // 另一台设备（slug=other）的 shard。
    await seedFile(vaultPath, ["secrets", "secrets_other.json"], {
      entries: { SR: { authorization: "__plain:other-device-token" } },
    });

    const loaded = await loadConnections(vaultPath, SLUG);
    const cfg = loaded.SR?.config as Record<string, unknown> | undefined;
    const otherShard = await readShard(vaultPath, "other");

    return [
      expect(
        "current device does NOT see other device's secret",
        cfg?.authorization === undefined,
        `actual=${String(cfg?.authorization)}`,
      ),
      expect(
        "other device shard left untouched",
        otherShard.SR?.authorization === "__plain:other-device-token",
      ),
    ];
  });
}

async function testRemoveDeletesFromSharedAndShard(): Promise<Check[]> {
  return withTempVault(async (vaultPath) => {
    await upsertConnection(vaultPath, SLUG, "SR", {
      kind: "http",
      config: { conn_id: 80, authorization: "sk-live-token" },
    });

    const after = await removeConnection(vaultPath, SLUG, "SR");
    const shared = await readSharedConfig(vaultPath);
    const shard = await readShard(vaultPath, SLUG);

    return [
      expect("removed from returned map", after.SR === undefined),
      expect("removed from shared connections.json", shared.SR === undefined),
      expect("removed from device shard", shard.SR === undefined),
    ];
  });
}

async function main(): Promise<void> {
  const checks = [
    ...(await testUpsertSplitsSecretIntoShard()),
    ...(await testLoadMergesSharedAndShard()),
    ...(await testBlankSecretDoesNotOverwriteShard()),
    ...(await testLegacyInlineSecretMigratesToShard()),
    ...(await testOtherDeviceShardNotReadOrModified()),
    ...(await testRemoveDeletesFromSharedAndShard()),
  ];
  const failed = checks.filter((c) => !c.pass);
  for (const c of checks) {
    console.log(
      `${c.pass ? "ok" : "FAIL"} - ${c.name}${c.details ? ` (${c.details})` : ""}`,
    );
  }
  if (failed.length > 0) process.exit(1);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
