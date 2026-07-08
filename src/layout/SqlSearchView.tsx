/**
 * SearchPanel「SQL 模式」。
 *
 * 三层结构化筛选：操作（读/写）→ 表名（模糊匹配 facets.tables）→ 列名（模糊
 * 匹配该表下出现过的列，未选表时禁用）。任意一层选定表名后即可查询。
 *
 * 结果按文件分组：每行显示操作类型 badge、命中表/列高亮、右侧 run-date，
 * 点击跳转到 runsql 块（复用 useWorkspace.openFile 的 scrollToLine）。
 */

import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { FuzzyCombobox } from "@/components/fuzzy-combobox";
import { useT } from "@/i18n/use-t";
import { cn } from "@/lib/utils";
import type { SqlIndexHit } from "@/services/sql-index";
import { installSqlIndexSubscriber, useSqlSearch, type SqlOpKind } from "@/state/sql-search";
import { useWorkspace } from "@/state/workspace";

interface Props {
  vaultPath: string;
}

export function SqlSearchView({ vaultPath }: Props) {
  const t = useT();
  const openFile = useWorkspace((s) => s.openFile);

  const opKind = useSqlSearch((s) => s.opKind);
  const table = useSqlSearch((s) => s.table);
  const column = useSqlSearch((s) => s.column);
  const hits = useSqlSearch((s) => s.hits);
  const facets = useSqlSearch((s) => s.facets);
  const status = useSqlSearch((s) => s.status);
  const loading = useSqlSearch((s) => s.loading);
  const error = useSqlSearch((s) => s.error);
  const staleToken = useSqlSearch((s) => s.staleToken);
  const hasSearched = useSqlSearch((s) => s.hasSearched);
  const setOpKind = useSqlSearch((s) => s.setOpKind);
  const setTable = useSqlSearch((s) => s.setTable);
  const setColumn = useSqlSearch((s) => s.setColumn);
  const search = useSqlSearch((s) => s.search);
  const clear = useSqlSearch((s) => s.clear);
  const runQuery = useSqlSearch((s) => s.runQuery);
  const loadFacets = useSqlSearch((s) => s.loadFacets);
  const refreshStatus = useSqlSearch((s) => s.refreshStatus);

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  // 面板首次挂载时装一次订阅（幂等），并立刻拉一次 facets/status——用户可能
  // 在索引已经就绪很久之后才第一次切到 SQL 模式。
  useEffect(() => installSqlIndexSubscriber(), []);
  useEffect(() => {
    void loadFacets();
    void refreshStatus();
  }, [loadFacets, refreshStatus]);

  const grouped = useMemo(() => groupHitsByPath(hits), [hits]);
  const highlightTerms = useMemo(() => {
    const set = new Set<string>();
    const bareTable = table.trim().split(".").pop();
    if (bareTable) set.add(bareTable);
    if (column.trim()) set.add(column.trim());
    return [...set];
  }, [table, column]);
  // 跳转到右侧文档时顺带高亮命中的表/列名，不然只是滚过去、不知道具体在哪一行
  // 哪个字段。列名更具体，优先用它；没有列名时退化到裸表名。
  const jumpKeyword = column.trim() || table.trim().split(".").pop() || "";

  const tableColumns = table.trim() ? (facets?.tableColumns[table.trim()] ?? []) : [];
  const columnDisabled = opKind === "read" || table.trim() === "";
  const canSearch = table.trim() !== "";

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-2.5 py-2">
        <div className="flex items-center gap-1.5">
          <OpKindToggle value={opKind} onChange={setOpKind} />
          <FuzzyCombobox
            value={table}
            onChange={setTable}
            onCommit={(v) => {
              setTable(v);
              void runQuery();
            }}
            options={facets?.tables ?? []}
            placeholder={t("sqlSearch.tablePlaceholder")}
            className="flex-1"
          />
        </div>
        <div className="mt-1.5 flex items-center gap-1.5">
          <FuzzyCombobox
            value={column}
            onChange={setColumn}
            onCommit={(v) => {
              setColumn(v);
              void runQuery();
            }}
            options={tableColumns}
            placeholder={t("sqlSearch.columnPlaceholder")}
            disabled={columnDisabled}
            disabledHint={
              opKind === "read" ? t("sqlSearch.columnDisabledRead") : t("sqlSearch.columnDisabledNoTable")
            }
            className="flex-1"
          />
          <button
            type="button"
            onClick={() => void search()}
            disabled={!canSearch || loading}
            className="flex-none rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40"
          >
            {t("sqlSearch.search")}
          </button>
          {table.trim() || column.trim() ? (
            <button
              type="button"
              onClick={clear}
              className="flex-none text-[10px] text-muted-foreground underline hover:text-foreground"
            >
              {t("sqlSearch.clearAll")}
            </button>
          ) : null}
        </div>

        {status.state === "building" ? (
          <div className="mt-1.5 text-[10px] text-muted-foreground">
            {t("sqlSearch.building", {
              processed: status.processedFiles,
              total: status.totalFiles,
            })}
          </div>
        ) : null}

        <div className="mt-1.5 flex items-center justify-between text-[10px] text-muted-foreground">
          <span>
            {!hasSearched
              ? t("sqlSearch.start")
              : t("sqlSearch.count", { hits: hits.length, files: grouped.length })}
          </span>
          {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
        </div>

        {staleToken > 0 && hasSearched && !loading ? (
          <div className="mt-1 flex items-center justify-between gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[10px] text-amber-900 dark:text-amber-200">
            <span>{t("sqlSearch.stale")}</span>
            <button
              type="button"
              onClick={() => void runQuery()}
              className="rounded border border-amber-700/30 px-1.5 py-0.5 text-[10px] font-medium hover:bg-amber-500/20"
            >
              {t("sqlSearch.rerun")}
            </button>
          </div>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? <div className="px-3 py-3 text-xs text-destructive">{error}</div> : null}
        {!error && hasSearched && hits.length === 0 && !loading ? (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            {t("sqlSearch.empty")}
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
                <span className="truncate font-medium">{relPath(path, vaultPath)}</span>
                <span className="ml-auto text-[10px] text-muted-foreground">
                  {items.length}
                </span>
              </button>
              {!isCollapsed
                ? items.map((hit, idx) => (
                    <button
                      key={`${hit.path}:${hit.blockIndex}:${idx}`}
                      type="button"
                      onClick={() =>
                        openFile(hit.path, {
                          scrollToLine: hit.line,
                          keyword: jumpKeyword || undefined,
                          caseSensitive: false,
                        })
                      }
                      className="flex w-full items-start gap-2 px-3 py-1 text-left text-[11px] hover:bg-sidebar-hover"
                    >
                      <span className="w-8 flex-none text-right font-mono text-muted-foreground">
                        {hit.line}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          {hit.operations.map((op) => (
                            <span
                              key={op}
                              className="rounded bg-accent px-1 text-[9px] font-medium uppercase text-muted-foreground"
                            >
                              {op}
                            </span>
                          ))}
                          {hit.connectionName ? (
                            <span className="truncate text-[9px] text-muted-foreground">
                              {hit.connectionName}
                            </span>
                          ) : null}
                          {hit.runDate ? (
                            <span className="ml-auto flex-none text-[9px] text-muted-foreground">
                              {hit.runDate}
                            </span>
                          ) : null}
                        </span>
                        <span className="mt-0.5 block break-all font-mono text-[10px] text-muted-foreground">
                          <HighlightedSqlSnippet snippet={hit.snippet} terms={highlightTerms} />
                        </span>
                      </span>
                    </button>
                  ))
                : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function OpKindToggle({
  value,
  onChange,
}: {
  value: SqlOpKind;
  onChange: (kind: SqlOpKind) => void;
}) {
  const t = useT();
  const options: { kind: SqlOpKind; label: string }[] = [
    { kind: "write", label: t("sqlSearch.opWrite") },
    { kind: "read", label: t("sqlSearch.opRead") },
  ];
  return (
    <div className="flex flex-none overflow-hidden rounded-md border border-border">
      {options.map(({ kind, label }) => (
        <button
          key={kind}
          type="button"
          onClick={() => onChange(kind)}
          className={cn(
            "px-2 py-1 text-[11px] font-medium",
            value === kind
              ? "bg-primary text-primary-foreground"
              : "bg-background text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function groupHitsByPath(hits: SqlIndexHit[]): { path: string; items: SqlIndexHit[] }[] {
  const map = new Map<string, SqlIndexHit[]>();
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

function HighlightedSqlSnippet({
  snippet,
  terms,
}: {
  snippet: string;
  terms: string[];
}) {
  if (terms.length === 0) return <>{snippet}</>;
  const escaped = terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`(${escaped.join("|")})`, "gi");
  const lowerSet = new Set(terms.map((term) => term.toLowerCase()));
  const parts = snippet.split(re);
  return (
    <>
      {parts.map((part, i) =>
        lowerSet.has(part.toLowerCase()) ? (
          <mark
            key={i}
            className="rounded-sm bg-amber-200 px-0.5 text-amber-900 dark:bg-amber-700/60 dark:text-amber-100"
          >
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}
