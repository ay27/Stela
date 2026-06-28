/**
 * Plugins 设置面板（M5）
 *
 * 列出 main 端注册的所有 connector：
 *   - builtin（mysql / http）：只展示 kind / displayName，不可卸载
 *   - subprocess：展示 kind / displayName / exePath / 进程是否存活 / 最近 stderr 日志
 *
 * 操作：
 *   - 安装：通过 `dialog.pickFile` 选可执行文件，可选填 args（空格分隔），主进程 spawn
 *     完成 hello 握手后写入 manifest，并加入注册表
 *   - 卸载：仅 subprocess 可用，会停掉子进程并从 manifest 移除
 *   - 查看日志：从 main 端 ring buffer 拉取最近若干行 stderr，提供刷新按钮
 *
 * 与 ConnectionsTab 解耦：本 tab 只管「安装哪些 connector kind」，连接（kind+config 实例）
 * 的 CRUD 仍在 Connections tab。
 */

import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  FolderOpen,
  Info,
  Loader2,
  Play,
  Plug,
  Plus,
  RefreshCw,
  RotateCw,
  Square,
  Trash2,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { useT } from "@/i18n/use-t";
import {
  fetchBundledPlugins,
  usePluginLogs,
  usePluginsList,
} from "@/services/plugins";
import { TabContainer } from "./atoms";

import type { BundledPluginInfo, PluginInfo } from "@shared/types";

interface InstallDraft {
  exePath: string;
  argsText: string;
  envText: string;
}

const EMPTY_DRAFT: InstallDraft = {
  exePath: "",
  argsText: "",
  envText: "",
};

export function PluginsTab() {
  const t = useT();
  const {
    items,
    loading,
    error,
    refresh,
    install,
    installModule,
    installBundled,
    uninstall,
    start,
    stop,
    restart,
  } = usePluginsList();
  const [selectedKind, setSelectedKind] = useState<string | null>(null);
  const [installOpen, setInstallOpen] = useState(false);
  const [moduleOpen, setModuleOpen] = useState(false);

  const selected = useMemo(
    () => items.find((p) => p.kind === selectedKind) ?? null,
    [items, selectedKind],
  );

  useEffect(() => {
    if (!selectedKind && items.length > 0) {
      setSelectedKind(items[0]!.kind);
    }
    if (
      selectedKind &&
      items.length > 0 &&
      !items.some((p) => p.kind === selectedKind)
    ) {
      setSelectedKind(items[0]?.kind ?? null);
    }
  }, [items, selectedKind]);

  return (
    <TabContainer>
      <header className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">
            {t("plugins.title")}
          </h3>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {t("plugins.description", {
              path: "",
            }).split("{path}")[0]}
            <code className="rounded bg-muted px-1 py-0.5 font-mono">
              {"{vault}/.stela/plugins/"}
            </code>
            {t("plugins.description", {
              path: "{path}",
            }).split("{path}")[1]}
          </p>
        </div>
        <div className="flex flex-none items-center gap-2">
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading}
            className={cn(
              "inline-flex items-center gap-1 rounded-md border border-border bg-background px-2.5 py-1.5 text-[11px] text-foreground hover:bg-accent",
              loading && "opacity-60",
            )}
          >
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            {t("common.refresh")}
          </button>
          <button
            type="button"
            onClick={() => setModuleOpen(true)}
            className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1.5 text-[11px] font-medium text-primary-foreground hover:opacity-90"
          >
            <Plus className="h-3.5 w-3.5" />
            {t("plugins.moduleButton")}
          </button>
          <button
            type="button"
            onClick={() => setInstallOpen(true)}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2.5 py-1.5 text-[11px] font-medium text-foreground hover:bg-accent"
          >
            <Plus className="h-3.5 w-3.5" />
            {t("plugins.subprocessButton")}
          </button>
        </div>
      </header>

      {error ? (
        <div className="mb-3 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-none" />
          <span>{t("plugins.listFailed", { message: error })}</span>
        </div>
      ) : null}

      <div className="flex min-h-[360px] gap-3">
        <PluginList
          items={items}
          selected={selectedKind}
          loading={loading}
          onSelect={(k) => setSelectedKind(k)}
        />
        <PluginDetail
          plugin={selected}
          onUninstall={async (kind) => {
            await uninstall(kind);
          }}
          onStart={async (kind) => {
            await start(kind);
          }}
          onStop={async (kind) => {
            await stop(kind);
          }}
          onRestart={async (kind) => {
            await restart(kind);
          }}
        />
      </div>

      {installOpen ? (
        <InstallDialog
          onClose={() => setInstallOpen(false)}
          onSubmit={async (draft) => {
            const args = parseArgs(draft.argsText);
            const env = parseEnv(draft.envText);
            const info = await install({
              exePath: draft.exePath,
              args: args.length > 0 ? args : undefined,
              env: env && Object.keys(env).length > 0 ? env : undefined,
            });
            setSelectedKind(info.kind);
          }}
        />
      ) : null}

      {moduleOpen ? (
        <ModuleInstallDialog
          onClose={() => setModuleOpen(false)}
          installModule={installModule}
          installBundled={installBundled}
          onInstalled={(kind) => setSelectedKind(kind)}
        />
      ) : null}
    </TabContainer>
  );
}

/**
 * Module 插件安装对话框：
 *   - 上半：应用自带（bundled）插件 catalog，一键安装
 *   - 下半：从本地目录安装（pickDirectory 选含 plugin.json + dist/index.cjs 的包目录）
 *
 * 醒目的安全提示：module 插件以完整权限运行，安装即完全信任。
 */
function ModuleInstallDialog({
  onClose,
  installModule,
  installBundled,
  onInstalled,
}: {
  onClose: () => void;
  installModule: (input: { srcDir: string }) => Promise<PluginInfo>;
  installBundled: (id: string) => Promise<PluginInfo>;
  onInstalled: (kind: string) => void;
}) {
  const t = useT();
  const [bundled, setBundled] = useState<BundledPluginInfo[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reloadBundled = async () => {
    try {
      setBundled(await fetchBundledPlugins());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    void reloadBundled();
  }, []);

  const onInstallBundled = async (id: string) => {
    if (busy) return;
    setBusy(id);
    setError(null);
    try {
      const info = await installBundled(id);
      onInstalled(info.kind);
      await reloadBundled();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const onPickDir = async () => {
    if (busy) return;
    let dir: string | null;
    try {
      dir = await window.stela.dialog.pickDirectory({
        title: t("plugins.moduleInstall.dialogTitle"),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    if (!dir) return;
    setBusy("__dir__");
    setError(null);
    try {
      const info = await installModule({ srcDir: dir });
      onInstalled(info.kind);
      await reloadBundled();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-[560px] max-w-full rounded-lg border border-border bg-background p-4 shadow-xl">
        <h4 className="mb-2 text-sm font-semibold text-foreground">
          {t("plugins.moduleInstall.title")}
        </h4>
        <div className="mb-3 flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[11px] text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-none" />
          <span>
            {t("plugins.moduleInstall.warning")}
          </span>
        </div>

        <section className="mb-4">
          <h5 className="mb-1.5 text-[12px] font-medium text-foreground">
            {t("plugins.moduleInstall.bundled")}
          </h5>
          <div className="rounded-md border border-border">
            {bundled === null ? (
              <div className="flex items-center gap-1.5 px-3 py-3 text-[11px] text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />{" "}
                {t("common.loading")}
              </div>
            ) : bundled.length === 0 ? (
              <div className="px-3 py-3 text-[11px] text-muted-foreground">
                {t("plugins.moduleInstall.noBundled")}
              </div>
            ) : (
              <ul className="divide-y divide-border/60">
                {bundled.map((b) => (
                  <li
                    key={b.id}
                    className="flex items-center justify-between gap-3 px-3 py-2 text-[12px]"
                  >
                    <div className="min-w-0">
                      <div className="truncate font-medium">
                        {b.displayName}
                      </div>
                      <div className="truncate font-mono text-[10.5px] text-muted-foreground">
                        {b.id}
                      </div>
                    </div>
                    {b.installed ? (
                      <span className="inline-flex flex-none items-center gap-1 rounded border border-emerald-300 bg-emerald-50 px-1.5 py-0.5 text-[10.5px] text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300">
                        <CheckCircle2 className="h-3 w-3" />{" "}
                        {t("plugins.moduleInstall.installed")}
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void onInstallBundled(b.id)}
                        disabled={busy !== null}
                        className={cn(
                          "inline-flex flex-none items-center gap-1 rounded-md bg-primary px-2 py-1 text-[11px] font-medium text-primary-foreground hover:opacity-90",
                          busy !== null && "opacity-60",
                        )}
                      >
                        {busy === b.id ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <Plus className="h-3 w-3" />
                        )}
                        {t("plugins.moduleInstall.install")}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        <section className="mb-4">
          <h5 className="mb-1.5 text-[12px] font-medium text-foreground">
            {t("plugins.moduleInstall.local")}
          </h5>
          <p className="mb-2 text-[11px] text-muted-foreground">
            {t("plugins.moduleInstall.localHint")}
          </p>
          <button
            type="button"
            onClick={() => void onPickDir()}
            disabled={busy !== null}
            className={cn(
              "inline-flex items-center gap-1 rounded-md border border-border bg-background px-2.5 py-1.5 text-[11px] hover:bg-accent",
              busy !== null && "opacity-60",
            )}
          >
            {busy === "__dir__" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <FolderOpen className="h-3.5 w-3.5" />
            )}
            {t("plugins.moduleInstall.chooseDir")}
          </button>
        </section>

        {error ? (
          <div className="mb-3 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-none" />
            <span>{error}</span>
          </div>
        ) : null}

        <div className="flex items-center justify-end">
          <button
            type="button"
            onClick={onClose}
            disabled={busy !== null}
            className="rounded-md border border-border bg-background px-3 py-1.5 text-[11px] hover:bg-accent"
          >
            {t("plugins.moduleInstall.close")}
          </button>
        </div>
      </div>
    </div>
  );
}

function PluginList({
  items,
  selected,
  loading,
  onSelect,
}: {
  items: PluginInfo[];
  selected: string | null;
  loading: boolean;
  onSelect: (kind: string) => void;
}) {
  const t = useT();
  if (loading && items.length === 0) {
    return (
      <aside className="flex w-56 flex-none items-center justify-center rounded-md border border-border bg-card/40 text-[11px] text-muted-foreground">
        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
        {t("common.loading")}
      </aside>
    );
  }
  return (
    <aside className="w-56 flex-none overflow-auto rounded-md border border-border bg-card/40">
      <ul className="divide-y divide-border/60">
        {items.map((p) => {
          const active = p.kind === selected;
          return (
            <li key={p.kind}>
              <button
                type="button"
                onClick={() => onSelect(p.kind)}
                className={cn(
                  "flex w-full items-start gap-2 px-3 py-2 text-left text-[12px]",
                  active
                    ? "bg-accent text-foreground"
                    : "hover:bg-accent/60 text-foreground",
                )}
              >
                <Plug
                  className={cn(
                    "mt-0.5 h-3.5 w-3.5 flex-none",
                    p.source === "subprocess"
                      ? "text-sky-500"
                      : p.source === "module"
                        ? "text-violet-500"
                        : "text-muted-foreground",
                  )}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate font-medium">{p.kind}</span>
                    <SourceBadge source={p.source} />
                  </div>
                  <div className="mt-0.5 truncate text-[10.5px] text-muted-foreground">
                    {p.displayName}
                  </div>
                  {p.source === "subprocess" ? (
                    <AliveBadge alive={p.alive} />
                  ) : null}
                </div>
              </button>
            </li>
          );
        })}
        {items.length === 0 ? (
          <li className="px-3 py-4 text-center text-[11px] text-muted-foreground">
            {t("plugins.empty")}
          </li>
        ) : null}
      </ul>
    </aside>
  );
}

function PluginDetail({
  plugin,
  onUninstall,
  onStart,
  onStop,
  onRestart,
}: {
  plugin: PluginInfo | null;
  onUninstall: (kind: string) => Promise<void>;
  onStart: (kind: string) => Promise<void>;
  onStop: (kind: string) => Promise<void>;
  onRestart: (kind: string) => Promise<void>;
}) {
  const t = useT();
  if (!plugin) {
    return (
      <div className="flex flex-1 items-center justify-center rounded-md border border-dashed border-border bg-card/30 text-[11px] text-muted-foreground">
        {t("plugins.selectPrompt")}
      </div>
    );
  }
  return (
    <div className="flex flex-1 flex-col overflow-hidden rounded-md border border-border bg-card/40">
      <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h4 className="truncate text-sm font-semibold text-foreground">
              {plugin.kind}
            </h4>
            <SourceBadge source={plugin.source} />
            {plugin.source === "subprocess" ? (
              <AliveBadge alive={plugin.alive} />
            ) : null}
          </div>
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
            {plugin.displayName}
          </p>
        </div>
        {plugin.source === "subprocess" || plugin.source === "module" ? (
          <UninstallButton kind={plugin.kind} onUninstall={onUninstall} />
        ) : (
          <span className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/50 px-2 py-1 text-[10.5px] text-muted-foreground">
            <Info className="h-3 w-3" /> {t("plugins.builtinLocked")}
          </span>
        )}
      </header>

      <div className="flex-1 overflow-auto px-4 py-3">
        {plugin.source === "subprocess" ? (
          <SubprocessDetail
            plugin={plugin}
            onStart={onStart}
            onStop={onStop}
            onRestart={onRestart}
          />
        ) : plugin.source === "module" ? (
          <ModuleDetail plugin={plugin} />
        ) : (
          <BuiltinDetail plugin={plugin} />
        )}
      </div>
    </div>
  );
}

function BuiltinDetail({ plugin }: { plugin: PluginInfo }) {
  const t = useT();
  return (
    <dl className="grid grid-cols-[110px_1fr] gap-y-2 text-[12px]">
      <dt className="text-muted-foreground">{t("plugins.field.source")}</dt>
      <dd>{t("plugins.source.builtin")}</dd>
      <dt className="text-muted-foreground">Kind</dt>
      <dd className="font-mono">{plugin.kind}</dd>
      <dt className="text-muted-foreground">{t("plugins.field.description")}</dt>
      <dd className="text-muted-foreground">{plugin.displayName}</dd>
    </dl>
  );
}

function ModuleDetail({ plugin }: { plugin: PluginInfo }) {
  const t = useT();
  return (
    <div className="space-y-4">
      {plugin.loadError ? (
        <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-none" />
          <span>{t("plugins.loadFailed", { message: plugin.loadError })}</span>
        </div>
      ) : (
        <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[11px] text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-none" />
          <span>
            {t("plugins.moduleWarning")}
          </span>
        </div>
      )}
      <dl className="grid grid-cols-[110px_1fr] gap-y-2 text-[12px]">
        <dt className="text-muted-foreground">{t("plugins.field.source")}</dt>
        <dd>{t("plugins.source.module")}</dd>
        <dt className="text-muted-foreground">Kind</dt>
        <dd className="font-mono">{plugin.kind}</dd>
        <dt className="text-muted-foreground">{t("plugins.field.description")}</dt>
        <dd className="text-muted-foreground">{plugin.displayName}</dd>
        <dt className="text-muted-foreground">{t("plugins.field.installDir")}</dt>
        <dd className="break-all font-mono text-[11px]">{plugin.dir ?? "—"}</dd>
        <dt className="text-muted-foreground">{t("plugins.field.status")}</dt>
        <dd>
          {plugin.loadError
            ? t("plugins.status.loadError")
            : t("plugins.status.loaded")}
        </dd>
      </dl>
    </div>
  );
}

function SubprocessDetail({
  plugin,
  onStart,
  onStop,
  onRestart,
}: {
  plugin: PluginInfo;
  onStart: (kind: string) => Promise<void>;
  onStop: (kind: string) => Promise<void>;
  onRestart: (kind: string) => Promise<void>;
}) {
  const t = useT();
  const { logs, refreshLogs } = usePluginLogs(plugin.kind);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsError, setLogsError] = useState<string | null>(null);

  const onRefreshLogs = async () => {
    setLogsLoading(true);
    setLogsError(null);
    try {
      await refreshLogs();
    } catch (err) {
      setLogsError(err instanceof Error ? err.message : String(err));
    } finally {
      setLogsLoading(false);
    }
  };

  useEffect(() => {
    void onRefreshLogs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plugin.kind]);

  return (
    <div className="space-y-4">
      <LifecycleBar
        plugin={plugin}
        onStart={onStart}
        onStop={onStop}
        onRestart={onRestart}
        onAfterChange={onRefreshLogs}
      />

      <dl className="grid grid-cols-[110px_1fr] gap-y-2 text-[12px]">
        <dt className="text-muted-foreground">{t("plugins.field.source")}</dt>
        <dd>{t("plugins.source.subprocess")}</dd>
        <dt className="text-muted-foreground">Kind</dt>
        <dd className="font-mono">{plugin.kind}</dd>
        <dt className="text-muted-foreground">{t("plugins.field.exePath")}</dt>
        <dd className="break-all font-mono text-[11px]">
          {plugin.exePath ?? "—"}
        </dd>
        <dt className="text-muted-foreground">{t("plugins.field.args")}</dt>
        <dd className="break-all font-mono text-[11px]">
          {plugin.args && plugin.args.length > 0 ? plugin.args.join(" ") : "—"}
        </dd>
        <dt className="text-muted-foreground">{t("plugins.field.process")}</dt>
        <dd>
          <AliveBadge alive={plugin.alive} />
        </dd>
      </dl>

      <section>
        <div className="mb-1.5 flex items-center justify-between">
          <h5 className="text-[12px] font-medium text-foreground">
            {t("plugins.stderr.title")}
          </h5>
          <button
            type="button"
            onClick={() => void onRefreshLogs()}
            disabled={logsLoading}
            className={cn(
              "inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-[10.5px] text-foreground hover:bg-accent",
              logsLoading && "opacity-60",
            )}
          >
            {logsLoading ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="h-3 w-3" />
            )}
            {t("plugins.stderr.refresh")}
          </button>
        </div>
        {logsError ? (
          <p className="mb-1 text-[10.5px] text-destructive">
            {t("plugins.stderr.failed", { message: logsError })}
          </p>
        ) : null}
        <pre
          className={cn(
            "max-h-64 min-h-[120px] overflow-auto rounded-md border border-border bg-background px-3 py-2 font-mono text-[11px] leading-relaxed text-foreground",
            "whitespace-pre-wrap break-words",
          )}
        >
          {logs.length > 0
            ? logs.join("\n")
            : t("plugins.stderr.empty")}
        </pre>
      </section>
    </div>
  );
}

/**
 * 子进程 plugin 的 lifecycle 控件。
 *
 * 按钮可见性策略：
 *   - 进程存活：显示「停止」「重启」
 *   - 进程未运行：显示「启动」「重启」（重启等于 stop+start 的强制刷新，未运行时退化成 start）
 *
 * 子进程上次操作的错误显示在按钮下方一行小字，避免弹窗打断流。
 * 操作后拉一次最近 stderr，便于看到 hello 握手 / spawn 失败的原因。
 */
function LifecycleBar({
  plugin,
  onStart,
  onStop,
  onRestart,
  onAfterChange,
}: {
  plugin: PluginInfo;
  onStart: (kind: string) => Promise<void>;
  onStop: (kind: string) => Promise<void>;
  onRestart: (kind: string) => Promise<void>;
  onAfterChange: () => void | Promise<void>;
}) {
  const t = useT();
  const [busy, setBusy] = useState<"start" | "stop" | "restart" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (
    op: "start" | "stop" | "restart",
    fn: () => Promise<void>,
  ) => {
    if (busy) return;
    setBusy(op);
    setError(null);
    try {
      await fn();
      await onAfterChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const alive = plugin.alive === true;
  const startBtn = (
    <button
      type="button"
      onClick={() => void run("start", () => onStart(plugin.kind))}
      disabled={busy !== null || alive}
      className={cn(
        "inline-flex items-center gap-1 rounded-md border border-emerald-300 bg-emerald-50 px-2 py-1 text-[11px] text-emerald-700 hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-200 dark:hover:bg-emerald-900/50",
        (busy !== null || alive) && "opacity-60",
      )}
      title={
        alive
          ? t("plugins.lifecycle.startTitleRunning")
          : t("plugins.lifecycle.startTitle")
      }
    >
      {busy === "start" ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : (
        <Play className="h-3 w-3" />
      )}
      {t("plugins.lifecycle.start")}
    </button>
  );
  const stopBtn = (
    <button
      type="button"
      onClick={() => void run("stop", () => onStop(plugin.kind))}
      disabled={busy !== null || !alive}
      className={cn(
        "inline-flex items-center gap-1 rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] text-amber-700 hover:bg-amber-100 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-200 dark:hover:bg-amber-900/50",
        (busy !== null || !alive) && "opacity-60",
      )}
      title={
        alive
          ? t("plugins.lifecycle.stopTitle")
          : t("plugins.lifecycle.stoppedTitle")
      }
    >
      {busy === "stop" ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : (
        <Square className="h-3 w-3" />
      )}
      {t("plugins.lifecycle.stop")}
    </button>
  );
  const restartBtn = (
    <button
      type="button"
      onClick={() => void run("restart", () => onRestart(plugin.kind))}
      disabled={busy !== null}
      className={cn(
        "inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-[11px] text-foreground hover:bg-accent",
        busy !== null && "opacity-60",
      )}
      title={t("plugins.lifecycle.restartTitle")}
    >
      {busy === "restart" ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : (
        <RotateCw className="h-3 w-3" />
      )}
      {t("plugins.lifecycle.restart")}
    </button>
  );

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
      <span className="font-medium text-foreground">
        {t("plugins.lifecycle.title")}
      </span>
      <span className="text-muted-foreground/70">·</span>
      <AliveBadge alive={plugin.alive} />
      <div className="ml-auto flex items-center gap-2">
        {startBtn}
        {stopBtn}
        {restartBtn}
      </div>
      {error ? (
        <p className="basis-full text-[10.5px] text-destructive">
          {t("plugins.lifecycle.failed", { message: error })}
        </p>
      ) : null}
    </div>
  );
}

function UninstallButton({
  kind,
  onUninstall,
}: {
  kind: string;
  onUninstall: (kind: string) => Promise<void>;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const click = async () => {
    if (busy) return;
    if (!window.confirm(t("plugins.uninstall.confirm", { kind })))
      return;
    setBusy(true);
    setError(null);
    try {
      await onUninstall(kind);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={() => void click()}
        disabled={busy}
        className={cn(
          "inline-flex items-center gap-1 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-[11px] text-destructive hover:bg-destructive/20",
          busy && "opacity-60",
        )}
      >
        {busy ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <Trash2 className="h-3 w-3" />
        )}
        {t("plugins.uninstall")}
      </button>
      {error ? (
        <span className="text-[10.5px] text-destructive">{error}</span>
      ) : null}
    </div>
  );
}

function SourceBadge({ source }: { source: PluginInfo["source"] }) {
  if (source === "builtin") {
    return (
      <span className="inline-flex items-center rounded border border-border bg-muted/50 px-1.5 py-0.5 text-[9.5px] uppercase tracking-wide text-muted-foreground">
        builtin
      </span>
    );
  }
  if (source === "module") {
    return (
      <span className="inline-flex items-center rounded border border-violet-300 bg-violet-50 px-1.5 py-0.5 text-[9.5px] uppercase tracking-wide text-violet-700 dark:border-violet-800 dark:bg-violet-950/50 dark:text-violet-300">
        module
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded border border-sky-300 bg-sky-50 px-1.5 py-0.5 text-[9.5px] uppercase tracking-wide text-sky-700 dark:border-sky-800 dark:bg-sky-950/50 dark:text-sky-300">
      subprocess
    </span>
  );
}

function AliveBadge({ alive }: { alive: boolean | undefined }) {
  const t = useT();
  if (alive === undefined) return null;
  return alive ? (
    <span className="mt-1 inline-flex items-center gap-1 rounded border border-emerald-300 bg-emerald-50 px-1.5 py-0.5 text-[9.5px] text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300">
      <CheckCircle2 className="h-2.5 w-2.5" />
      {t("plugins.alive")}
    </span>
  ) : (
    <span className="mt-1 inline-flex items-center gap-1 rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[9.5px] text-amber-700 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-300">
      <AlertTriangle className="h-2.5 w-2.5" />
      {t("plugins.notRunning")}
    </span>
  );
}

function InstallDialog({
  onClose,
  onSubmit,
}: {
  onClose: () => void;
  onSubmit: (draft: InstallDraft) => Promise<void>;
}) {
  const t = useT();
  const [draft, setDraft] = useState<InstallDraft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onPickExe = async () => {
    try {
      const picked = await window.stela.dialog.pickFile({
        title: t("plugins.install.dialogTitle"),
      });
      if (picked) setDraft((d) => ({ ...d, exePath: picked }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onConfirm = async (e: FormEvent) => {
    e.preventDefault();
    if (!draft.exePath.trim()) {
      setError(t("plugins.install.noExecutable"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(draft);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form
        onSubmit={onConfirm}
        className="w-[520px] max-w-full rounded-lg border border-border bg-background p-4 shadow-xl"
      >
        <h4 className="mb-3 text-sm font-semibold text-foreground">
          {t("plugins.install.title")}
        </h4>
        <p className="mb-3 text-[11px] text-muted-foreground">
          {t("plugins.install.description")}
        </p>

        <label className="mb-3 block">
          <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {t("plugins.install.exePath")}
          </span>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={draft.exePath}
              onChange={(e) =>
                setDraft((d) => ({ ...d, exePath: e.target.value }))
              }
              placeholder="/Users/.../my-connector"
              className="w-full rounded-md border border-border bg-background px-2 py-1.5 font-mono text-[12px] focus:border-primary focus:outline-none"
            />
            <button
              type="button"
              onClick={() => void onPickExe()}
              className="inline-flex flex-none items-center gap-1 rounded-md border border-border bg-background px-2 py-1.5 text-[11px] hover:bg-accent"
            >
              <FolderOpen className="h-3.5 w-3.5" />
              {t("plugins.install.browse")}
            </button>
          </div>
        </label>

        <label className="mb-3 block">
          <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {t("plugins.install.args")}
          </span>
          <input
            type="text"
            value={draft.argsText}
            onChange={(e) =>
              setDraft((d) => ({ ...d, argsText: e.target.value }))
            }
            placeholder="--stdio --verbose"
            className="w-full rounded-md border border-border bg-background px-2 py-1.5 font-mono text-[12px] focus:border-primary focus:outline-none"
          />
        </label>

        <label className="mb-4 block">
          <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {t("plugins.install.env")}
          </span>
          <textarea
            value={draft.envText}
            onChange={(e) =>
              setDraft((d) => ({ ...d, envText: e.target.value }))
            }
            rows={3}
            placeholder="LOG_LEVEL=info&#10;HTTP_PROXY=http://127.0.0.1:7890"
            className="w-full rounded-md border border-border bg-background px-2 py-1.5 font-mono text-[12px] focus:border-primary focus:outline-none"
            spellCheck={false}
          />
        </label>

        {error ? (
          <div className="mb-3 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-none" />
            <span>{error}</span>
          </div>
        ) : null}

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-md border border-border bg-background px-3 py-1.5 text-[11px] hover:bg-accent"
          >
            {t("plugins.install.cancel")}
          </button>
          <button
            type="submit"
            disabled={busy}
            className={cn(
              "inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-[11px] font-medium text-primary-foreground hover:opacity-90",
              busy && "opacity-60",
            )}
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
            {t("plugins.moduleInstall.install")}
          </button>
        </div>
      </form>
    </div>
  );
}

function parseArgs(text: string): string[] {
  return text
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

function parseEnv(text: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (!key) continue;
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}
