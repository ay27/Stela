/**
 * Backlinks 面板（v0.3 双链 M3）。
 *
 * 挂在 EditorView 底部：折叠 / 展开由 [src/state/workspace.ts](../state/workspace.ts)
 * 的 `tab.backlinksOpen` 控制（per-tab 记忆）。
 *
 * 数据：通过 `window.stela.index.getBacklinks(path)` 查询当前文件被引用的源
 * 列表（含 snippet）；订阅 `window.stela.index.onChanged` 在 main 端索引刷新
 * 后自动重查。
 *
 * 不依赖 zustand 全局 store——backlinks 是纯 view-local 数据，路径变化即丢弃。
 */
import {
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  Link2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { IndexBacklinkEntry } from "@shared/types";
import { useWorkspace } from "@/state/workspace";
import { useT } from "@/i18n/use-t";

interface Props {
  path: string;
  tabId: string;
}

export function BacklinksPanel({ path, tabId }: Props) {
  const t = useT();
  const open = useWorkspace(
    (s) => s.tabs.find((t) => t.id === tabId)?.backlinksOpen ?? false,
  );
  const setBacklinksOpen = useWorkspace((s) => s.setBacklinksOpen);
  const openFile = useWorkspace((s) => s.openFile);

  const [entries, setEntries] = useState<IndexBacklinkEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reqIdRef = useRef(0);

  // 把绝对路径转成 wiki target 字符串：vault 根相对、去 .md
  const target = useMemo(() => {
    const vault = useWorkspace.getState().vaultPath;
    if (!vault) return path;
    const norm = (p: string) => p.replace(/\\/g, "/");
    const v = norm(vault).replace(/\/$/, "");
    const p = norm(path);
    const rel = p.startsWith(v + "/") ? p.slice(v.length + 1) : p;
    return rel.replace(/\.(md|mdstela)$/i, "");
  }, [path]);

  useEffect(() => {
    if (typeof window === "undefined" || !window.stela?.index) return;
    let cancelled = false;
    const fetchBacklinks = async () => {
      const reqId = ++reqIdRef.current;
      try {
        const result = await window.stela.index.getBacklinks(target);
        if (cancelled || reqIdRef.current !== reqId) return;
        setEntries(result);
        setError(null);
      } catch (err) {
        if (cancelled || reqIdRef.current !== reqId) return;
        setEntries([]);
        setError(err instanceof Error ? err.message : String(err));
      }
    };
    void fetchBacklinks();
    const unsub = window.stela.index.onChanged(() => {
      void fetchBacklinks();
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [target]);

  const count = entries?.length ?? 0;

  return (
    <div className="flex-none border-t border-border bg-muted/30">
      <button
        type="button"
        onClick={() => setBacklinksOpen(tabId, !open)}
        className="flex w-full items-center gap-2 px-4 py-1.5 text-left text-[12px] font-medium text-muted-foreground transition-colors hover:bg-muted/60"
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" />
        )}
        <Link2 className="h-3.5 w-3.5" />
        <span>{t("backlinks.title")}</span>
        <span className="text-muted-foreground/70">({count})</span>
      </button>
      {open ? (
        <div className="max-h-56 overflow-y-auto border-t border-border/80 px-2 pb-2 pt-1">
          {entries === null ? (
            <div className="px-2 py-3 text-[12px] text-muted-foreground">
              {t("backlinks.loading")}
            </div>
          ) : error ? (
            <div className="px-2 py-3 text-[12px] text-destructive">
              {error}
            </div>
          ) : count === 0 ? (
            <div className="px-2 py-3 text-[12px] text-muted-foreground">
              {t("backlinks.empty")}
            </div>
          ) : (
            <ul className="space-y-1">
              {entries.map((e, i) => (
                <li key={`${e.sourcePath}:${e.line}:${i}`}>
                  <button
                    type="button"
                    onClick={() => {
                      openFile(e.sourcePath);
                    }}
                    className="group block w-full rounded-md border border-transparent px-2 py-1 text-left transition-colors hover:border-border hover:bg-background"
                  >
                    <div className="flex items-center gap-2 text-[12px] font-medium text-foreground">
                      <CornerDownRight className="h-3 w-3 text-muted-foreground" />
                      <span className="truncate">{e.sourceTitle}</span>
                      <span className="ml-auto shrink-0 text-[10.5px] text-muted-foreground/80">
                        L{e.line}
                      </span>
                    </div>
                    <div
                      className="mt-0.5 truncate text-[11.5px] text-muted-foreground"
                      title={e.sourcePath}
                    >
                      {e.snippet}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
