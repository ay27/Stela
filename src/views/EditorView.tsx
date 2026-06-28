import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, Copy, FastForward, Loader2 } from "lucide-react";

import { readFile } from "@/services/fs";
import { writeFile } from "@/services/fs-write";
import { setKnownDiskContent } from "@/services/note-save-tracker";
import { useWorkspace } from "@/state/workspace";
import { useDialogs } from "@/state/dialogs";
import { MilkdownEditor, type MilkdownEditorHandle } from "@/editor/MilkdownEditor";
import { BacklinksPanel } from "@/components/backlinks-panel";
import { ConnectionPicker } from "@/components/connection-picker";
import { useConnections } from "@/state/connections";
import { firstConnectionName } from "@/services/connections";
import { useT } from "@/i18n/use-t";
import {
  parseFrontmatterField,
  splitFrontmatter,
  updateFrontmatterField,
} from "@/core/markdown";
import { cn } from "@/lib/utils";

export function EditorView({ tabId, path }: { tabId: string; path: string }) {
  const t = useT();
  const setDirty = useWorkspace((s) => s.setDirty);
  const openSettings = useDialogs((s) => s.setSettings);
  const entries = useConnections((s) => s.entries);
  const connectionsLoaded = useConnections((s) => s.loaded);
  const reloadConnections = useConnections((s) => s.reload);

  // 来自 watcher 的外部变更状态（v0.2 #7）。
  //   - reloadToken：clean tab 被外部改写时自动 +1，触发本组件重读磁盘
  //   - externalChange："changed" 时弹冲突 banner；"removed" 时弹删除 banner
  const reloadToken = useWorkspace(
    (s) => s.tabs.find((t) => t.id === tabId)?.reloadToken ?? 0,
  );
  const externalChange = useWorkspace(
    (s) => s.tabs.find((t) => t.id === tabId)?.externalChange,
  );
  const acceptExternalChange = useWorkspace((s) => s.acceptExternalChange);
  const dismissExternalChange = useWorkspace((s) => s.dismissExternalChange);
  const closeTab = useWorkspace((s) => s.closeTab);

  const [raw, setRaw] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 每次 connection_name 变更 ++，作为 MilkdownEditor 的 React key 触发重新挂载。
  // 重挂载代价可接受：切连接是低频操作，且未保存的 body 在 split/join 过程中会被再次 pick up。
  const [reloadNonce, setReloadNonce] = useState(0);
  const editorRef = useRef<MilkdownEditorHandle>(null);
  const [pathCopied, setPathCopied] = useState(false);
  const [runAllBusy, setRunAllBusy] = useState(false);
  const [runAllHint, setRunAllHint] = useState<string | null>(null);

  useEffect(() => {
    if (!connectionsLoaded) void reloadConnections();
  }, [connectionsLoaded, reloadConnections]);

  // 当前已加载的磁盘内容快照（含 frontmatter），供外部变更时做"内容是否真的变了"
  // 的比对。clean tab 下它恒等于磁盘内容（刚加载 / 刚保存），所以可靠。
  const rawRef = useRef<string | null>(null);
  useEffect(() => {
    rawRef.current = raw;
  }, [raw]);

  // 初始加载 / 切换文件：show Loading → 读盘 → 渲染。path 在 MilkdownEditor 的 key
  // 里，path 变化本身就会重挂，这里负责把新内容读进来。
  useEffect(() => {
    let alive = true;
    setRaw(null);
    setError(null);
    setReloadNonce((n) => n + 1);
    readFile(path)
      .then((text) => {
        if (!alive) return;
        setKnownDiskContent(path, text);
        setRaw(text);
      })
      .catch((err: unknown) => {
        if (alive) setError(String(err));
      });
    return () => {
      alive = false;
    };
  }, [path]);

  // 外部变更自动重读（watcher 检测到 clean tab 被外部修改时 bump reloadToken）。
  //
  // 关键：先读盘**比对内容**，只有与当前 buffer 真的不同才重载。这样能消除绝大多数
  // 无意义的闪烁——自写回声（suppress 偶发漏命中）、同步盘 / 外部 agent 原样重写、
  // 内容等价的格式化等，都不会再触发整体 remount。内容真变了才走重载。
  //
  // path 用 ref 读最新值：本 effect 只在 reloadToken 变化时跑，不把 path 放进依赖，
  // 避免切文件时与上面的初始加载 effect 抢跑、重复读盘。
  const pathRef = useRef(path);
  useEffect(() => {
    pathRef.current = path;
  }, [path]);
  const skipFirstReloadRef = useRef(true);
  useEffect(() => {
    // mount 时 reloadToken 初值会触发一次，跳过——初始加载交给上面的 effect
    if (skipFirstReloadRef.current) {
      skipFirstReloadRef.current = false;
      return;
    }
    let alive = true;
    readFile(pathRef.current)
      .then((text) => {
        if (!alive) return;
        // 内容与当前 buffer 一致 → 外部"变更"是无意义回声，不重载、不闪
        if (text === rawRef.current) return;
        setKnownDiskContent(pathRef.current, text);
        setRaw(text);
        // 真有变化：bump nonce 触发 MilkdownEditor 重挂，让新内容生效
        setReloadNonce((n) => n + 1);
      })
      .catch((err: unknown) => {
        if (alive) setError(String(err));
      });
    return () => {
      alive = false;
    };
  }, [reloadToken]);

  // frontmatter 显式指定 > 第一个已保存连接 > null。
  // 兜底是「纯展示 + 运行时」行为：**不会**自动写回 frontmatter，避免打开个老
  // 文件就把它悄悄改 dirty。用户点 Picker 主动选中时才走 updateFrontmatterField。
  const connectionName = useMemo(() => {
    if (raw === null) return null;
    const { frontmatter } = splitFrontmatter(raw);
    const explicit = parseFrontmatterField(frontmatter, "connection_name");
    if (explicit) return explicit;
    return firstConnectionName(entries);
  }, [raw, entries]);

  const onPickConnection = useCallback(
    async (name: string) => {
      if (raw === null) return;
      const next = updateFrontmatterField(raw, "connection_name", name);
      if (next === raw) return;
      setRaw(next);
      setReloadNonce((n) => n + 1);
      try {
        await writeFile(path, next);
      } catch (err) {
        console.error("[stela] write frontmatter failed", err);
      }
    },
    [path, raw],
  );

  const onCopyPath = useCallback(() => {
    window.stela.shell.writeClipboardText(path);
    setPathCopied(true);
    window.setTimeout(() => {
      setPathCopied((cur) => (cur ? false : cur));
    }, 1200);
  }, [path]);

  const onRunAllBlocks = useCallback(async () => {
    if (runAllBusy) return;
    setRunAllHint(null);
    setRunAllBusy(true);
    try {
      const outcome = await editorRef.current?.runAllBlocks();
      if (!outcome) {
        setRunAllHint(t("editor.runAll.notReady"));
        return;
      }
      if (outcome.total === 0) {
        setRunAllHint(t("editor.runAll.empty"));
        return;
      }
      if (outcome.failed === 0) {
        setRunAllHint(t("editor.runAll.done", { count: outcome.ran }));
      } else {
        setRunAllHint(
          t("editor.runAll.failed", {
            failed: outcome.failed,
            total: outcome.total,
            message: outcome.messages[0] ? `: ${outcome.messages[0]}` : "",
          }),
        );
      }
    } finally {
      setRunAllBusy(false);
      window.setTimeout(() => setRunAllHint(null), 3000);
    }
  }, [runAllBusy, t]);

  if (error) {
    return <div className="p-6 text-sm text-destructive">{error}</div>;
  }
  if (raw === null) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {t("common.loading")}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex flex-none items-center justify-between gap-3 border-b border-border px-4 py-2 text-xs text-muted-foreground">
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <div className="min-w-0 flex-1 truncate font-mono" title={path}>
            {path}
          </div>
          <button
            type="button"
            onClick={onCopyPath}
            className="stela-app-no-drag flex-none rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title={pathCopied ? t("common.copied") : t("editor.copyPath")}
            aria-label={pathCopied ? t("editor.copiedPath") : t("editor.copyPath")}
          >
            {pathCopied ? (
              <Check className="h-3.5 w-3.5" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
        <div className="flex flex-none items-center gap-1.5">
          <button
            type="button"
            onClick={() => void onRunAllBlocks()}
            disabled={runAllBusy || !connectionName}
            className={cn(
              "stela-app-no-drag inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium transition-colors",
              "hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-40",
            )}
            title={
              runAllHint ??
              (connectionName
                ? t("editor.runAll.title")
                : t("editor.runAll.noConnection"))
            }
          >
            {runAllBusy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <FastForward className="h-3.5 w-3.5" />
            )}
            <span className="hidden sm:inline">{t("editor.runAll")}</span>
          </button>
          <ConnectionPicker
            value={connectionName}
            onChange={onPickConnection}
            onOpenSettings={() => openSettings(true)}
          />
        </div>
      </div>
      {externalChange ? (
        <ExternalChangeBanner
          kind={externalChange}
          onReload={() => acceptExternalChange(tabId)}
          onKeep={() => dismissExternalChange(tabId)}
          onClose={() => closeTab(tabId)}
        />
      ) : null}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <MilkdownEditor
          ref={editorRef}
          // 注意：不把 connectionName 放进 key，否则 connections store 异步
          // 加载把 null → fallback 时会触发一次无意义的 editor 重挂。用户主动
          // 切连接走 reloadNonce，该重挂的还是会重挂。
          key={`${path}::${reloadNonce}`}
          path={path}
          initialRaw={raw}
          connectionName={connectionName}
          onDirtyChange={(dirty) => setDirty(tabId, dirty)}
          onPersist={async (next) => {
            setRaw(next);
            await writeFile(path, next);
          }}
        />
      </div>
      <BacklinksPanel path={path} tabId={tabId} />
    </div>
  );
}

function ExternalChangeBanner({
  kind,
  onReload,
  onKeep,
  onClose,
}: {
  kind: "changed" | "removed";
  onReload: () => void;
  onKeep: () => void;
  onClose: () => void;
}) {
  const t = useT();
  if (kind === "removed") {
    return (
      <div className="flex flex-none items-center gap-2 border-b border-amber-500/40 bg-amber-500/10 px-4 py-1.5 text-[12px] text-amber-900 dark:text-amber-200">
        <AlertTriangle className="h-3.5 w-3.5" />
        <span className="flex-1">
          {t("editor.external.removed")}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="rounded border border-amber-700/40 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium hover:bg-amber-500/20"
        >
          {t("editor.external.close")}
        </button>
      </div>
    );
  }
  return (
    <div className="flex flex-none items-center gap-2 border-b border-amber-500/40 bg-amber-500/10 px-4 py-1.5 text-[12px] text-amber-900 dark:text-amber-200">
      <AlertTriangle className="h-3.5 w-3.5" />
      <span className="flex-1">
        {t("editor.external.changed")}
      </span>
      <button
        type="button"
        onClick={onReload}
        className="rounded border border-amber-700/40 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium hover:bg-amber-500/20"
      >
        {t("editor.external.reload")}
      </button>
      <button
        type="button"
        onClick={onKeep}
        className="rounded border border-border bg-background px-2 py-0.5 text-[11px] font-medium hover:bg-accent"
      >
        {t("editor.external.keep")}
      </button>
    </div>
  );
}
