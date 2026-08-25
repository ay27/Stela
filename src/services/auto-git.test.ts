import assert from "node:assert/strict";

import type { GitSyncRequest, GitSyncResult, GitVaultStatus } from "@shared/types";

import { DEFAULT_APP_SETTINGS } from "@/contracts/settings";
import { resetAutoGit, scheduleAutoGit, useAutoGit } from "./auto-git";
import { useGitStore } from "@/state/git";
import { useSettings } from "@/state/settings";
import { useWorkspace } from "@/state/workspace";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const status: GitVaultStatus = {
  isRepo: true,
  branch: "main",
  hasRemote: true,
  ahead: 0,
  behind: 0,
  changedCount: 0,
  conflictCount: 0,
  conflictMode: "none",
};

function okResult(): GitSyncResult {
  return {
    committed: true,
    commitHash: "abc123",
    integrated: false,
    pushed: true,
    conflicted: false,
    conflictMode: "none",
    importedRuns: 0,
    changedDomains: [],
    blockedReason: null,
    message: "synchronized",
  };
}

const requests: GitSyncRequest[] = [];
let firstResolver: () => void = () => {};
let holdFirst = false;

globalThis.window = {
  stela: {
    git: {
      syncNow: async (request: GitSyncRequest) => {
        requests.push(request);
        if (holdFirst && requests.length === 1) {
          await new Promise<void>((resolve) => {
            firstResolver = resolve;
          });
        }
        return okResult();
      },
      vaultStatus: async () => status,
    },
  },
} as unknown as Window & typeof globalThis;

useSettings.setState({
  settings: {
    ...DEFAULT_APP_SETTINGS,
    git: {
      ...DEFAULT_APP_SETTINGS.git,
      enabled: true,
      autoCommit: true,
      autoPull: true,
      autoPush: true,
    },
  },
});
useGitStore.setState({ status });
useWorkspace.setState({ tabs: [] });

try {
  scheduleAutoGit("external-change");
  await wait(3_150);
  assert.equal(requests.length, 1, "external changes should sync after the quiet period");
  assert.equal(requests[0]?.trigger, "external");

  resetAutoGit();
  requests.length = 0;
  holdFirst = true;
  const first = useAutoGit.getState().flush("focus");
  await wait(20);
  const coalesced = useAutoGit.getState().flush("interval");
  await wait(20);
  assert.equal(requests.length, 1, "only one sync may be in flight");
  firstResolver();
  await first;
  await coalesced;
  await wait(50);
  assert.equal(requests.length, 2, "an in-flight trigger should produce one follow-up sync");
} finally {
  holdFirst = false;
  resetAutoGit();
}

console.log("auto-git tests passed.");
