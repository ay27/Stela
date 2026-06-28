/**
 * Git Pulse / 历史视图：最近提交流 + 逐提交文件变更 + 单文件 diff。
 *
 * 移植自 Tolaria 的 PulseView，适配 Stela 的 `window.stela.git.*`：
 *   - `vaultPulse` 拉最近提交（含每个提交的文件清单）
 *   - 点击文件 → `fileDiffAtCommit` 拉该提交对该文件的 diff，按 +/- 着色展示
 *
 * 嵌入 [`GitSyncDialog`](./git-sync-dialog.tsx) 的「历史」视图，不单独挂载。
 */

import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, GitCommitHorizontal, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { useT } from "@/i18n/use-t";
import type { GitPulseCommit, GitPulseFile } from "@shared/types";

const PULSE_LIMIT = 30;

function relativeTime(ms: number, t: ReturnType<typeof useT>): string {
  const diff = Date.now() - ms;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return t("git.pulse.time.justNow");
  if (min < 60) return t("git.pulse.time.minutes", { count: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return t("git.pulse.time.hours", { count: hr });
  const day = Math.floor(hr / 24);
  if (day < 30) return t("git.pulse.time.days", { count: day });
  return new Date(ms).toLocaleDateString();
}

const FILE_BADGE: Record<GitPulseFile["status"], { label: string; color: string }> = {
  modified: { label: "M", color: "text-amber-600" },
  added: { label: "A", color: "text-emerald-600" },
  deleted: { label: "D", color: "text-destructive" },
  renamed: { label: "R", color: "text-primary" },
};

export function GitPulse() {
  const t = useT();
  const [commits, setCommits] = useState<GitPulseCommit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    window.stela.git
      .vaultPulse(PULSE_LIMIT)
      .then((c) => {
        if (alive) setCommits(c);
      })
      .catch((err) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-10 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
        {error}
      </div>
    );
  }

  if (commits.length === 0) {
    return (
      <div className="py-10 text-center text-[12px] text-muted-foreground">
        {t("git.pulse.empty")}
      </div>
    );
  }

  return (
    <ul className="space-y-1">
      {commits.map((c) => (
        <li key={c.hash} className="rounded-md border border-border/60">
          <button
            type="button"
            onClick={() => setExpanded((h) => (h === c.hash ? null : c.hash))}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] hover:bg-muted/50"
          >
            {expanded === c.hash ? (
              <ChevronDown className="h-3.5 w-3.5 flex-none text-muted-foreground" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 flex-none text-muted-foreground" />
            )}
            <GitCommitHorizontal className="h-3.5 w-3.5 flex-none text-muted-foreground" />
            <span className="flex-1 truncate font-medium" title={c.message}>
              {c.message}
            </span>
            <span className="flex-none font-mono text-[10px] text-muted-foreground">
              {c.shortHash}
            </span>
            <span className="flex-none text-[10px] text-muted-foreground">
              {relativeTime(c.date, t)}
            </span>
          </button>
          {expanded === c.hash ? (
            <CommitFiles commit={c} />
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function CommitFiles({ commit }: { commit: GitPulseCommit }) {
  const t = useT();
  const [openFile, setOpenFile] = useState<string | null>(null);
  return (
    <div className="border-t border-border/50 px-3 py-2">
      <div className="mb-1 text-[10px] text-muted-foreground">
        {commit.author} · {t("git.pulse.fileCount", { count: commit.files.length })}
      </div>
      {commit.files.length === 0 ? (
        <div className="text-[11px] text-muted-foreground">
          {t("git.pulse.noFileChanges")}
        </div>
      ) : (
        <ul className="space-y-0.5">
          {commit.files.map((f) => {
            const badge = FILE_BADGE[f.status];
            return (
              <li key={f.path}>
                <button
                  type="button"
                  onClick={() =>
                    setOpenFile((p) => (p === f.path ? null : f.path))
                  }
                  className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-[11px] hover:bg-muted/50"
                >
                  <span className={cn("w-3 flex-none font-mono font-semibold", badge.color)}>
                    {badge.label}
                  </span>
                  <span className="truncate" title={f.path}>
                    {f.path}
                  </span>
                </button>
                {openFile === f.path && f.status !== "deleted" ? (
                  <FileDiff commitHash={commit.hash} path={f.path} />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function FileDiff({ commitHash, path }: { commitHash: string; path: string }) {
  const t = useT();
  const [diff, setDiff] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    window.stela.git
      .fileDiffAtCommit(path, commitHash)
      .then((d) => alive && setDiff(d))
      .catch((err) =>
        alive && setError(err instanceof Error ? err.message : String(err)),
      );
    return () => {
      alive = false;
    };
  }, [commitHash, path]);

  if (error) {
    return <div className="px-1.5 py-1 text-[11px] text-destructive">{error}</div>;
  }
  if (diff === null) {
    return (
      <div className="px-1.5 py-1 text-[11px] text-muted-foreground">
        {t("git.pulse.loadingDiff")}
      </div>
    );
  }

  return (
    <pre className="mt-1 max-h-60 overflow-auto rounded bg-muted/40 p-2 text-[10px] leading-relaxed">
      {diff.split("\n").map((line, i) => (
        <div
          key={i}
          className={cn(
            "whitespace-pre",
            line.startsWith("+") && !line.startsWith("+++") && "text-emerald-600",
            line.startsWith("-") && !line.startsWith("---") && "text-destructive",
            line.startsWith("@@") && "text-primary",
          )}
        >
          {line || " "}
        </div>
      ))}
    </pre>
  );
}
