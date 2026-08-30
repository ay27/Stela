import { execFileSync } from "node:child_process";

function git(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }).trim();
}

let insideWorktree = false;
try {
  insideWorktree = git(["rev-parse", "--is-inside-work-tree"]) === "true";
} catch {
  // npm install also runs in source archives and packaging contexts without
  // a Git worktree. Hook installation is optional there and must not fail.
}

if (insideWorktree) {
  try {
    let current = "";
    try {
      current = git(["config", "--local", "--get", "core.hooksPath"]);
    } catch {
      // An unset local hooksPath is the normal first-install state.
    }

    if (current && current !== ".githooks") {
      console.warn(
        `[stela] Git hooks not installed: core.hooksPath is already ${JSON.stringify(current)}.`,
      );
      process.exit(0);
    }

    if (current !== ".githooks") {
      git(["config", "--local", "core.hooksPath", ".githooks"]);
      console.log("[stela] Git pre-commit checks enabled.");
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`[stela] Git hooks not installed: ${detail}`);
  }
}
