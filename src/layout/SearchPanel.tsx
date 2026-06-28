/**
 * 全 vault 文本搜索面板。
 *
 * - 顶部：关键字 input（自动聚焦）+ Aa case sensitive toggle
 * - 中部：按文件分组的命中列表（默认全部展开），每条命中显示 line + 高亮 snippet
 * - 输入防抖 250ms 触发 [useSearch.run](../state/search.ts)，避免逐字符 invoke
 * - 点击命中：openFile(path)；M5 再支持 jump-to-line
 *
 * 与命令面板的区别：cmd+K 用 cmdk 模糊匹配文件名 / 命令；本面板做 vault 内全文 substring。
 */

import { CaseSensitive, ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { SearchHit } from "@/services/search";
import { useSearch } from "@/state/search";
import { useWorkspace } from "@/state/workspace";
import { useLayout } from "@/state/layout";
import { cn } from "@/lib/utils";
import { useT } from "@/i18n/use-t";

interface Props {
  vaultPath: string;
}

const DEBOUNCE_MS = 250;

export function SearchPanel({ vaultPath }: Props) {
  const t = useT();
  const openFile = useWorkspace((s) => s.openFile);
  const hits = useSearch((s) => s.hits);
  const loading = useSearch((s) => s.loading);
  const error = useSearch((s) => s.error);
  const run = useSearch((s) => s.run);
  const staleToken = useSearch((s) => s.staleToken);

  const [keyword, setKeyword] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const inputRef = useRef<HTMLInputElement>(null);
  const focusToken = useLayout((s) => s.searchFocusToken);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusToken]);

  // debounce
  useEffect(() => {
    const handle = window.setTimeout(() => {
      void run(vaultPath, keyword, { caseSensitive });
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [keyword, caseSensitive, vaultPath, run]);

  const grouped = useMemo(() => groupByFile(hits), [hits]);
  // 单文件最多渲染多少条命中。一个文件命中过百条时，全量渲染会让滚动 / 折叠
  // 切换都明显抖一下；超出部分只显示一行占位提示，引导用户改用更精确的关键词。
  const PER_FILE_RENDER_CAP = 50;

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-2.5 py-2">
        <div className="flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 focus-within:border-primary">
          <input
            ref={inputRef}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder={t("search.placeholder")}
            className="flex-1 bg-transparent py-0.5 text-[13px] focus:outline-none"
          />
          <button
            type="button"
            onClick={() => setCaseSensitive((v) => !v)}
            className={cn(
              "rounded p-1 text-muted-foreground hover:text-foreground",
              caseSensitive && "bg-accent text-foreground",
            )}
            title={t("search.caseSensitive")}
          >
            <CaseSensitive className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="mt-1.5 flex items-center justify-between text-[10px] text-muted-foreground">
          <span>
            {keyword.trim() === ""
              ? t("search.start")
              : t("search.count", {
                  hits: hits.length,
                  files: grouped.length,
                })}
          </span>
          {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
        </div>
        {staleToken > 0 && keyword.trim() !== "" && !loading ? (
          <div className="mt-1 flex items-center justify-between gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[10px] text-amber-900 dark:text-amber-200">
            <span>{t("search.stale")}</span>
            <button
              type="button"
              onClick={() => void run(vaultPath, keyword, { caseSensitive })}
              className="rounded border border-amber-700/30 px-1.5 py-0.5 text-[10px] font-medium hover:bg-amber-500/20"
            >
              {t("search.rerun")}
            </button>
          </div>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <div className="px-3 py-3 text-xs text-destructive">{error}</div>
        ) : null}
        {!error && hits.length === 0 && keyword.trim() !== "" && !loading ? (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            {t("search.empty")}
          </div>
        ) : null}
        {grouped.map(({ path, items }) => {
          const isCollapsed = collapsed.has(path);
          return (
            <div key={path} className="border-b border-border/60">
              <button
                type="button"
                onClick={() => {
                  setCollapsed((prev) => {
                    const next = new Set(prev);
                    if (next.has(path)) next.delete(path);
                    else next.add(path);
                    return next;
                  });
                }}
                className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-[11px] hover:bg-sidebar-hover"
                title={path}
              >
                {isCollapsed ? (
                  <ChevronRight className="h-3 w-3 text-muted-foreground" />
                ) : (
                  <ChevronDown className="h-3 w-3 text-muted-foreground" />
                )}
                <span className="truncate font-medium">
                  {relPath(path, vaultPath)}
                </span>
                <span className="ml-auto text-[10px] text-muted-foreground">
                  {items.length}
                </span>
              </button>
              {!isCollapsed ? (
                <>
                  {items.slice(0, PER_FILE_RENDER_CAP).map((hit, idx) => (
                    <button
                      key={`${hit.path}:${hit.line}:${hit.column}:${idx}`}
                      type="button"
                      onClick={() =>
                        openFile(hit.path, {
                          scrollToLine: hit.line,
                          scrollToColumn: hit.column,
                          keyword: keyword.trim() || undefined,
                          caseSensitive,
                          // 同文件内按 vault 返回顺序标号；MilkdownEditor 用 PM
                          // doc.descendants 找第 N 个命中，与此索引对齐。
                          nthInFile: idx,
                        })
                      }
                      className="flex w-full items-start gap-2 px-3 py-1 text-left text-[11px] hover:bg-sidebar-hover"
                    >
                      <span className="w-8 flex-none text-right font-mono text-muted-foreground">
                        {hit.line}
                      </span>
                      <span className="flex-1 break-all">
                        <HighlightedSnippet
                          snippet={hit.snippet}
                          keyword={keyword}
                          caseSensitive={caseSensitive}
                        />
                      </span>
                    </button>
                  ))}
                  {items.length > PER_FILE_RENDER_CAP ? (
                    <div className="px-3 py-1 text-[10px] italic text-muted-foreground">
                      {t("search.overflow", {
                        count: items.length - PER_FILE_RENDER_CAP,
                      })}
                    </div>
                  ) : null}
                </>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function groupByFile(hits: SearchHit[]): { path: string; items: SearchHit[] }[] {
  const map = new Map<string, SearchHit[]>();
  for (const h of hits) {
    const arr = map.get(h.path);
    if (arr) arr.push(h);
    else map.set(h.path, [h]);
  }
  return Array.from(map.entries()).map(([path, items]) => ({ path, items }));
}

function relPath(path: string, vaultPath: string): string {
  if (!path.startsWith(vaultPath)) return path;
  return path.slice(vaultPath.length).replace(/^\/+/, "");
}

function HighlightedSnippet({
  snippet,
  keyword,
  caseSensitive,
}: {
  snippet: string;
  keyword: string;
  caseSensitive: boolean;
}) {
  const k = keyword.trim();
  if (!k) return <span>{snippet}</span>;
  const haystack = caseSensitive ? snippet : snippet.toLowerCase();
  const needle = caseSensitive ? k : k.toLowerCase();
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  let i = 0;
  while (true) {
    const found = haystack.indexOf(needle, cursor);
    if (found < 0) {
      parts.push(<span key={i++}>{snippet.slice(cursor)}</span>);
      break;
    }
    if (found > cursor) {
      parts.push(<span key={i++}>{snippet.slice(cursor, found)}</span>);
    }
    parts.push(
      <mark
        key={i++}
        className="rounded-sm bg-amber-200 px-0.5 text-amber-900 dark:bg-amber-700/60 dark:text-amber-100"
      >
        {snippet.slice(found, found + needle.length)}
      </mark>,
    );
    cursor = found + needle.length;
  }
  return <>{parts}</>;
}
