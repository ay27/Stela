/**
 * Git & 执行历史设置面板（替代旧的 COS Sync tab）。
 *
 * 分区：
 *   - 仓库：启用 Git / init / 远端 URL + addRemote / 作者身份
 *   - 自动化：autoCommit / autoPush / autoPull + 间隔
 *   - 设备与执行历史：device slug、JSONL 来源列表、从日志重建缓存、导出已有 runs
 *
 * 不持有任何凭据——远端认证完全委托系统 git（SSH key / credential helper）。
 */

import { useEffect, useState } from "react";
import {
  CheckCircle2,
  GitBranch,
  Loader2,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { useT } from "@/i18n/use-t";
import { useSettings } from "@/state/settings";
import { useGitStore, refreshGitStatus } from "@/state/git";
import { startAutoPull } from "@/services/auto-git";
import type {
  DeviceProfile,
  GitAuthorIdentity,
  JournalSource,
} from "@shared/types";

import { Row, Section, TabContainer, Toggle } from "./atoms";

const PULL_INTERVAL_OPTIONS: { value: number; labelKey: string }[] = [
  { value: 60_000, labelKey: "git.interval.1m" },
  { value: 300_000, labelKey: "git.interval.5m" },
  { value: 900_000, labelKey: "git.interval.15m" },
  { value: 1_800_000, labelKey: "git.interval.30m" },
];

/**
 * 历史日志清理保留窗口（天）。
 * 与 SQLite cleanup 用同一组刻度（30/90/180/365），保持设置体感一致。
 */
const CLEANUP_KEEP_OPTIONS: { value: number; labelKey: string }[] = [
  { value: 30, labelKey: "git.cleanup.keep30" },
  { value: 90, labelKey: "git.cleanup.keep90" },
  { value: 180, labelKey: "git.cleanup.keep180" },
  { value: 365, labelKey: "git.cleanup.keep365" },
];

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function GitTab() {
  const t = useT();
  const settings = useSettings((s) => s.settings);
  const patch = useSettings((s) => s.patch);
  const git = settings.git;
  const status = useGitStore((s) => s.status);
  const phase = useGitStore((s) => s.phase);

  const [remoteUrl, setRemoteUrl] = useState("");
  const [author, setAuthor] = useState<GitAuthorIdentity | null>(null);
  const [profile, setProfile] = useState<DeviceProfile | null>(null);
  const [slugDraft, setSlugDraft] = useState("");
  const [sources, setSources] = useState<JournalSource[]>([]);
  const [cleanupKeepDays, setCleanupKeepDays] = useState<number>(90);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadAll = async () => {
    try {
      refreshGitStatus();
      const [auth, prof, srcs] = await Promise.all([
        window.stela.git.authorIdentity().catch(() => null),
        window.stela.journal.getDeviceProfile().catch(() => null),
        window.stela.journal.listSources().catch(() => []),
      ]);
      setAuthor(auth);
      setProfile(prof);
      if (prof) setSlugDraft(prof.slug);
      setSources(srcs);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    void loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const onInit = () =>
    run("init", async () => {
      await window.stela.git.initRepo();
      await loadAll();
      setNotice(t("git.notice.initialized"));
    });

  const onAddRemote = () =>
    run("remote", async () => {
      const r = await window.stela.git.addRemote(remoteUrl.trim());
      await loadAll();
      setNotice(
        r.remoteHasHistory
          ? t("git.notice.remoteAddedWithHistory")
          : t("git.notice.remoteAdded"),
      );
      setRemoteUrl("");
    });

  const onSaveAuthor = () =>
    run("author", async () => {
      if (!author) return;
      await window.stela.git.setAuthorIdentity(author.name, author.email);
      setNotice(t("git.notice.authorSaved"));
    });

  const onSaveSlug = () =>
    run("slug", async () => {
      const p = await window.stela.journal.setDeviceSlug(slugDraft.trim());
      setProfile(p);
      setSlugDraft(p.slug);
      await loadAll();
      setNotice(t("git.notice.slugSaved", { slug: p.slug }));
    });

  const onRebuild = () =>
    run("rebuild", async () => {
      const s = await window.stela.journal.rebuildCache();
      await loadAll();
      setNotice(t("git.notice.rebuilt", { count: s.imported }));
    });

  const onExport = () =>
    run("export", async () => {
      const n = await window.stela.journal.exportExisting();
      await loadAll();
      setNotice(
        n > 0
          ? t("git.notice.exported", { count: n })
          : t("git.notice.exportEmpty"),
      );
    });

  const onCleanup = () =>
    run("cleanup", async () => {
      const s = await window.stela.journal.cleanupOlderThan(cleanupKeepDays);
      await loadAll();
      if (s.linesDeleted === 0) {
        setNotice(t("git.notice.cleanupEmpty", { days: cleanupKeepDays }));
      } else {
        setNotice(
          t("git.notice.cleanupDone", {
            lines: s.linesDeleted,
            rewritten: s.filesRewritten,
            files: s.filesDeleted,
            runs: s.runsDeleted,
          }),
        );
      }
    });

  return (
    <TabContainer>
      <Section
        title={t("git.repo.title")}
        description={t("git.repo.description")}
      >
        <Row
          label={t("git.enabled")}
          description={t("git.enabled.description")}
        >
          <Toggle
            checked={git.enabled}
            onChange={(v) => void patch({ git: { enabled: v } })}
          />
        </Row>

        <div className="flex items-center gap-2 rounded-md border border-border/60 bg-card/40 px-3 py-2.5 text-[12px]">
          <GitBranch className="h-4 w-4 text-muted-foreground" />
          {status.isRepo ? (
            <span>
              {t("git.repo.ready")}
              {status.branch ? t("git.repo.branch", { branch: status.branch }) : ""}
              {status.hasRemote
                ? t("git.repo.remoteConfigured")
                : t("git.repo.remoteMissing")}
            </span>
          ) : (
            <span className="text-muted-foreground">
              {t("git.repo.notRepo")}
            </span>
          )}
          {!status.isRepo ? (
            <button
              type="button"
              onClick={() => void onInit()}
              disabled={!git.enabled || busy !== null}
              className="ml-auto inline-flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1.5 text-[12px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {busy === "init" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : null}
              {t("git.repo.init")}
            </button>
          ) : null}
        </div>

        {status.isRepo && !status.hasRemote ? (
          <div className="rounded-md border border-border/60 bg-card/40 px-3 py-2.5">
            <div className="text-[13px] font-medium">
              {t("git.remote.title")}
            </div>
            <div className="mt-2 flex gap-2">
              <input
                value={remoteUrl}
                onChange={(e) => setRemoteUrl(e.target.value)}
                placeholder="git@github.com:user/vault.git"
                className="flex-1 rounded-md border border-border bg-background px-2.5 py-1.5 text-[12px] focus:outline-none focus:ring-2 focus:ring-ring"
              />
              <button
                type="button"
                onClick={() => void onAddRemote()}
                disabled={!remoteUrl.trim() || busy !== null}
                className="rounded-md bg-primary px-3 py-1.5 text-[12px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
              >
                {busy === "remote" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  t("git.remote.add")
                )}
              </button>
            </div>
          </div>
        ) : null}

        {status.isRepo ? (
          <div className="rounded-md border border-border/60 bg-card/40 px-3 py-2.5">
            <div className="text-[13px] font-medium">
              {t("git.author.title")}
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <input
                value={author?.name ?? ""}
                onChange={(e) =>
                  setAuthor((a) => ({
                    name: e.target.value,
                    email: a?.email ?? "",
                  }))
                }
                placeholder={t("git.author.name")}
                className="rounded-md border border-border bg-background px-2.5 py-1.5 text-[12px] focus:outline-none focus:ring-2 focus:ring-ring"
              />
              <input
                value={author?.email ?? ""}
                onChange={(e) =>
                  setAuthor((a) => ({
                    name: a?.name ?? "",
                    email: e.target.value,
                  }))
                }
                placeholder={t("git.author.email")}
                className="rounded-md border border-border bg-background px-2.5 py-1.5 text-[12px] focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <button
              type="button"
              onClick={() => void onSaveAuthor()}
              disabled={busy !== null}
              className="mt-2 rounded-md border border-border px-3 py-1.5 text-[12px] font-medium hover:bg-muted disabled:opacity-50"
            >
              {busy === "author" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                t("git.author.save")
              )}
            </button>
          </div>
        ) : null}
      </Section>

      <Section
        title={t("git.automation.title")}
        description={t("git.automation.description")}
      >
        <Row
          label={t("git.autoCommit")}
          description={t("git.autoCommit.description")}
        >
          <Toggle
            checked={git.autoCommit}
            onChange={(v) => void patch({ git: { autoCommit: v } })}
            disabled={!git.enabled}
          />
        </Row>
        <Row label={t("git.autoPush")} description={t("git.autoPush.description")}>
          <Toggle
            checked={git.autoPush}
            onChange={(v) => void patch({ git: { autoPush: v } })}
            disabled={!git.enabled || !git.autoCommit}
          />
        </Row>
        <Row
          label={t("git.autoPull")}
          description={t("git.autoPull.description")}
        >
          <Toggle
            checked={git.autoPull}
            onChange={(v) => {
              void patch({ git: { autoPull: v } }).then(() => startAutoPull());
            }}
            disabled={!git.enabled}
          />
        </Row>
        <Row label={t("git.pullInterval")} disabled={!git.enabled || !git.autoPull}>
          <select
            value={git.autoPullIntervalMs}
            onChange={(e) => {
              void patch({
                git: { autoPullIntervalMs: Number(e.target.value) },
              }).then(() => startAutoPull());
            }}
            disabled={!git.enabled || !git.autoPull}
            className="rounded-md border border-border bg-background px-2 py-1.5 text-[12px] focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
          >
            {PULL_INTERVAL_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {t(o.labelKey)}
              </option>
            ))}
          </select>
        </Row>
      </Section>

      <Section
        title={t("git.device.title")}
        description={t("git.device.description")}
      >
        <div className="rounded-md border border-border/60 bg-card/40 px-3 py-2.5">
          <div className="text-[13px] font-medium">{t("git.slug.title")}</div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            {t("git.slug.description")}
          </div>
          <div className="mt-2 flex gap-2">
            <input
              value={slugDraft}
              onChange={(e) => setSlugDraft(e.target.value)}
              placeholder="macbook"
              className="flex-1 rounded-md border border-border bg-background px-2.5 py-1.5 text-[12px] focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <button
              type="button"
              onClick={() => void onSaveSlug()}
              disabled={
                !slugDraft.trim() ||
                slugDraft.trim() === profile?.slug ||
                busy !== null
              }
              className="rounded-md border border-border px-3 py-1.5 text-[12px] font-medium hover:bg-muted disabled:opacity-50"
            >
              {busy === "slug" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                t("git.slug.save")
              )}
            </button>
          </div>
        </div>

        <div className="rounded-md border border-border/60 bg-card/40 px-3 py-2.5">
          <div className="flex items-center justify-between">
            <div className="text-[13px] font-medium">{t("git.sources.title")}</div>
            <button
              type="button"
              onClick={() => void loadAll()}
              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              title={t("common.refresh")}
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          </div>
          {sources.length === 0 ? (
            <div className="mt-2 text-[11px] text-muted-foreground">
              {t("git.sources.empty")}
            </div>
          ) : (
            <ul className="mt-2 space-y-1">
              {sources.map((s) => (
                <li
                  key={s.relPath}
                  className="flex items-center justify-between gap-2 text-[11px]"
                >
                  <span className="truncate font-mono" title={s.relPath}>
                    history_{s.slug}.jsonl
                    {s.isCurrentDevice ? t("git.sources.current") : ""}
                  </span>
                  <span className="flex-none text-muted-foreground">
                    {formatBytes(s.importedBytes)} / {formatBytes(s.sizeBytes)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-md border border-border/60 bg-card/40 px-3 py-2.5">
          <div className="text-[13px] font-medium">{t("git.cleanup.title")}</div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            {t("git.cleanup.description")}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <select
              value={cleanupKeepDays}
              onChange={(e) => setCleanupKeepDays(Number(e.target.value))}
              className="rounded-md border border-border bg-background px-2 py-1.5 text-[12px] focus:outline-none focus:ring-2 focus:ring-ring"
            >
              {CLEANUP_KEEP_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {t(o.labelKey)}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void onCleanup()}
              disabled={busy !== null}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-[12px] font-medium hover:bg-muted disabled:opacity-50"
            >
              {busy === "cleanup" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" />
              )}
              {t("git.cleanup.now")}
            </button>
          </div>
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void onExport()}
            disabled={busy !== null}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-[12px] font-medium hover:bg-muted disabled:opacity-50"
          >
            {busy === "export" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Upload className="h-3.5 w-3.5" />
            )}
            {t("git.export")}
          </button>
          <button
            type="button"
            onClick={() => void onRebuild()}
            disabled={busy !== null}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-[12px] font-medium hover:bg-muted disabled:opacity-50"
          >
            {busy === "rebuild" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            {t("git.rebuild")}
          </button>
        </div>
      </Section>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
          {error}
        </div>
      ) : notice ? (
        <div
          className={cn(
            "flex items-center gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-[12px] text-emerald-700",
          )}
        >
          <CheckCircle2 className="h-3.5 w-3.5" />
          {notice}
        </div>
      ) : null}

      {phase === "loading" ? (
        <p className="mt-2 text-[11px] text-muted-foreground">
          {t("common.loading")}
        </p>
      ) : null}
    </TabContainer>
  );
}
