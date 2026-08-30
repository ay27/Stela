import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { classifyChangedDomains, syncNow } from "./sync-orchestrator";

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd });
  return result.stdout.trim();
}

async function configureIdentity(repo: string): Promise<void> {
  await runGit(repo, ["config", "user.name", "Stela Sync Test"]);
  await runGit(repo, ["config", "user.email", "sync-test@stela.local"]);
  // Test repositories must not inherit machine/runner Git behavior. In
  // particular, Git for Windows may enable autocrlf, fsmonitor, or the
  // untracked cache globally. Keep the fixture independent of those settings
  // when checking whether the first checkpoint has files to commit.
  await runGit(repo, ["config", "core.autocrlf", "false"]);
  await runGit(repo, ["config", "core.filemode", "false"]);
  await runGit(repo, ["config", "core.fsmonitor", "false"]);
  await runGit(repo, ["config", "core.untrackedCache", "false"]);
  await runGit(repo, ["config", "commit.gpgsign", "false"]);
}

async function assertPendingPaths(repo: string, paths: string[]): Promise<void> {
  const status = await runGit(repo, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  for (const expected of paths) {
    assert.equal(
      status
        .split("\n")
        .some((line) => line.slice(3).replaceAll("\\", "/") === expected),
      true,
      `expected Git to see ${expected} before sync; status=${JSON.stringify(status)}`,
    );
  }
}

function normalizeNewlines(value: string): string {
  return value.replaceAll("\r\n", "\n");
}

const root = await mkdtemp(path.join(tmpdir(), "stela-sync-orchestrator-"));

try {
  assert.deepEqual(
    new Set(classifyChangedDomains([
      "notes/report.md",
      ".stela/settings.json",
      ".stela/connections.json",
      ".stela/history/device.jsonl",
      ".stela/agent-history/session.jsonl",
      ".stela/skills/example/SKILL.md",
      ".stela/sql-templates/query.md",
      ".stela/plugins/private/plugin.json",
    ])),
    new Set([
      "vault-files",
      "settings",
      "connections",
      "history",
      "agent-history",
      "skills",
      "templates",
    ]),
  );

  const remote = path.join(root, "origin.git");
  const deviceA = path.join(root, "device-a");
  const deviceB = path.join(root, "device-b");
  const verifier = path.join(root, "verifier");
  await runGit(root, ["init", "--bare", remote]);
  await runGit(root, ["clone", remote, deviceA]);
  await configureIdentity(deviceA);
  await writeFile(path.join(deviceA, "shared.txt"), "base\n", "utf-8");
  await runGit(deviceA, ["add", "."]);
  await runGit(deviceA, ["commit", "-m", "base"]);
  await runGit(deviceA, ["push", "-u", "origin", "HEAD"]);
  await runGit(root, ["clone", remote, deviceB]);
  await configureIdentity(deviceB);

  await writeFile(path.join(deviceA, "device-a.txt"), "from a\n", "utf-8");
  await mkdir(path.join(deviceA, ".stela"), { recursive: true });
  await writeFile(path.join(deviceA, ".stela", "settings.json"), "{}\n", "utf-8");
  await assertPendingPaths(deviceA, ["device-a.txt", ".stela/settings.json"]);
  const pushedA = await syncNow(deviceA, {
    trigger: "auto",
    commit: true,
    integrate: true,
    push: true,
    message: "device a checkpoint",
  });
  assert.equal(pushedA.committed, true);
  assert.equal(pushedA.pushed, true);

  await writeFile(path.join(deviceB, "device-b.txt"), "from b\n", "utf-8");
  const rebasedB = await syncNow(deviceB, {
    trigger: "external",
    commit: true,
    integrate: true,
    push: true,
    message: "device b checkpoint",
  });
  assert.equal(rebasedB.integrated, true);
  assert.equal(rebasedB.pushed, true);
  assert.equal(rebasedB.conflicted, false);
  assert.equal(rebasedB.changedDomains.includes("settings"), true);

  // Exercise the Windows checkout shape on every platform. Sync correctness is
  // about the text content; a verifier worktree may use CRLF via autocrlf.
  await runGit(root, ["-c", "core.autocrlf=true", "clone", remote, verifier]);
  assert.equal(
    normalizeNewlines(await readFile(path.join(verifier, "device-a.txt"), "utf-8")),
    "from a\n",
  );
  assert.equal(
    normalizeNewlines(await readFile(path.join(verifier, "device-b.txt"), "utf-8")),
    "from b\n",
  );

  await writeFile(path.join(deviceB, "single-flight.txt"), "serialized\n", "utf-8");
  const concurrent = await Promise.all([
    syncNow(deviceB, {
      trigger: "auto",
      commit: true,
      integrate: true,
      push: true,
      message: "first coalesced checkpoint",
    }),
    syncNow(deviceB, {
      trigger: "interval",
      commit: true,
      integrate: true,
      push: true,
      message: "second coalesced checkpoint",
    }),
  ]);
  assert.equal(concurrent.filter((result) => result.committed).length, 1);
  assert.equal(concurrent.some((result) => result.conflicted), false);

  await syncNow(deviceA, {
    trigger: "manual",
    commit: false,
    integrate: true,
    push: false,
  });
  await writeFile(path.join(deviceA, "shared.txt"), "device a wins?\n", "utf-8");
  await writeFile(path.join(deviceB, "shared.txt"), "device b wins?\n", "utf-8");
  await syncNow(deviceA, {
    trigger: "auto",
    commit: true,
    integrate: true,
    push: true,
    message: "device a conflicting edit",
  });
  const conflict = await syncNow(deviceB, {
    trigger: "auto",
    commit: true,
    integrate: true,
    push: true,
    message: "device b conflicting edit",
  });
  assert.equal(conflict.conflicted, true);
  assert.equal(conflict.conflictMode, "rebase");
  assert.equal(conflict.blockedReason, "conflict");
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("sync-orchestrator tests passed.");
