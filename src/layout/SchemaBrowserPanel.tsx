/**
 * Schema 浏览器侧栏面板（v0.2 #4）。
 *
 * - 顶部：连接选择器（默认取当前编辑文件 frontmatter 的 connection_name）+ 刷新按钮
 * - 中部：按 db 折叠的 table 列表；HTTP 等无库 connector 退化为单组（标题 "(no database)"）
 * - 点击表：展开行，懒加载该表的列结构（`SELECT * FROM x LIMIT 0` 拿 result.columns），
 *   并显示两个动作按钮：复制表名 / 复制 SELECT *。再次点击折叠。
 * - 错误：刷新失败时整体显示一行错误提示，不破坏已加载的旧数据
 *
 * 列结构使用 `LIMIT 0` 探针：
 *   - 跨方言通用（MySQL / PG / SQLite / 大多数 Lakehouse SQL）
 *   - 不会拉数据，对线上库压力小
 *   - 失败兜底：在该行内 inline 展示错误信息（典型是 HTTP / CSV 这类不支持任意
 *     SQL 的 connector），不污染整个面板
 *
 * 设计取舍：本期不做"双击插入到当前 RunSQL block"——RunSQL NodeView 的焦点 /
 * 选区状态非常敏感（参考 codeblock-nodeview.ts 注释），从侧栏跨过去插字符
 * 容易踩到 setSelection 抢焦点的历史问题。复制到剪贴板足够 v0.2 验收。
 */

import {
  ChevronDown,
  ChevronRight,
  Copy,
  Database,
  FileCode,
  Loader2,
  RefreshCw,
  Table as TableIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { ColumnDef } from "@/contracts";
import { fetchColumnsForTable } from "@/editor/runsql/fetch-columns";
import { fetchSchemaGroups, type SchemaGroup } from "@/editor/runsql/fetch-schema";
import { useConnections } from "@/state/connections";
import { useWorkspace } from "@/state/workspace";
import { getRunContext } from "@/editor/runsql/run-context";
import { useT } from "@/i18n/use-t";
import { cn } from "@/lib/utils";

interface SchemaState {
  loading: boolean;
  error: string | null;
  groups: SchemaGroup[];
}

interface ColumnState {
  loading: boolean;
  error: string | null;
  columns: ColumnDef[] | null;
}

const INITIAL_STATE: SchemaState = {
  loading: false,
  error: null,
  groups: [],
};

const INITIAL_COL_STATE: ColumnState = {
  loading: false,
  error: null,
  columns: null,
};

export function SchemaBrowserPanel() {
  const t = useT();
  const entries = useConnections((s) => s.entries);
  const loaded = useConnections((s) => s.loaded);
  const reload = useConnections((s) => s.reload);
  const activeTabId = useWorkspace((s) => s.activeTabId);

  const connectionNames = useMemo(() => Object.keys(entries).sort(), [entries]);

  const [selected, setSelected] = useState<string | null>(null);
  const [state, setState] = useState<SchemaState>(INITIAL_STATE);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  /** 已展开的表 → 列状态。key = qualified table name（db.table 或裸 table）。 */
  const [columnsByTable, setColumnsByTable] = useState<
    Record<string, ColumnState>
  >({});
  /** 复制到剪贴板的瞬时反馈。key 为按钮唯一 id，1.2s 后自动清掉。 */
  const [flash, setFlash] = useState<string | null>(null);

  // connections store 还没加载过时，主动拉一次。其它组件一般已经触发过 reload，
  // 这里 idempotent。
  useEffect(() => {
    if (!loaded) void reload();
  }, [loaded, reload]);

  // 默认选中：优先当前活跃 tab 关联的 connection_name，其次第一个连接。
  // activeTabId 变化时只在"当前没有用户手动选择"时才换；用户手动选过就保留。
  useEffect(() => {
    if (selected && entries[selected]) return;
    const ctx = getRunContext();
    const fromTab = ctx?.connectionName;
    if (fromTab && entries[fromTab]) {
      setSelected(fromTab);
      return;
    }
    setSelected(connectionNames[0] ?? null);
  }, [activeTabId, connectionNames, entries, selected]);

  const refresh = useCallback(async (name: string) => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const groups = await fetchSchemaGroups(name);
      setState({ loading: false, error: null, groups });
      // 切连接 / 刷新都把 columns cache 整体清掉——schema 可能已变
      setColumnsByTable({});
    } catch (err) {
      setState((s) => ({
        ...s,
        loading: false,
        error: (err as Error)?.message ?? t("schema.fetchFailed"),
      }));
    }
  }, []);

  // 切连接 → 自动拉一次
  useEffect(() => {
    if (!selected) {
      setState(INITIAL_STATE);
      setColumnsByTable({});
      return;
    }
    void refresh(selected);
  }, [selected, refresh]);

  const toggleGroup = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  /** 用于 columnsByTable 的 key + flash 反馈用的 button id。 */
  const tableKey = (db: string | null, table: string) =>
    db ? `${db}.${table}` : table;

  const fetchColumns = useCallback(
    async (name: string, db: string | null, table: string) => {
      const key = tableKey(db, table);
      if (!useConnections.getState().get(name)) return;
      setColumnsByTable((prev) => ({
        ...prev,
        [key]: { loading: true, error: null, columns: null },
      }));
      // 列元数据的 LIMIT 0 探针 + 错误归一化由 fetchColumnsForTable 统一处理
      // —— 侧栏与 RunSQL 列名补全共用同一份实现。
      try {
        const columns = await fetchColumnsForTable(name, db, table);
        setColumnsByTable((prev) => ({
          ...prev,
          [key]: { loading: false, error: null, columns },
        }));
      } catch (err) {
        setColumnsByTable((prev) => ({
          ...prev,
          [key]: {
            loading: false,
            error:
              err instanceof Error ? err.message : t("schema.fetchColumnsFailed"),
            columns: null,
          },
        }));
      }
    },
    [],
  );

  const toggleTable = (db: string | null, table: string) => {
    const key = tableKey(db, table);
    setColumnsByTable((prev) => {
      // 已经存在条目 → 折叠（删除条目）；不存在 → 标记为 loading 占位，
      // 下一行 useEffect 会真正去拉
      if (key in prev) {
        const next = { ...prev };
        delete next[key];
        return next;
      }
      return prev;
    });
    // 用 setTimeout 避开同一 tick 内 react double-render；同时若 selected 缺失就直接放弃
    if (!selected) return;
    if (key in columnsByTable) return; // 折叠分支已在上方 setState 处理
    void fetchColumns(selected, db, table);
  };

  const onCopy = async (label: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setFlash(label);
      window.setTimeout(() => {
        setFlash((cur) => (cur === label ? null : cur));
      }, 1200);
    } catch {
      // 剪贴板权限被拒，静默
    }
  };

  const totalTables = state.groups.reduce((n, g) => n + g.tables.length, 0);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-2.5 py-2">
        <div className="flex items-center gap-1.5">
          <Database className="h-3.5 w-3.5 text-muted-foreground" />
          <select
            value={selected ?? ""}
            onChange={(e) => setSelected(e.target.value || null)}
            disabled={connectionNames.length === 0}
            className={cn(
              "min-w-0 flex-1 rounded-md border border-border bg-background px-1.5 py-1 text-[12px]",
              "focus:border-primary focus:outline-none disabled:cursor-not-allowed disabled:opacity-50",
            )}
          >
            {connectionNames.length === 0 ? (
              <option value="">{t("schema.noConnection")}</option>
            ) : (
              connectionNames.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))
            )}
          </select>
          <button
            type="button"
            onClick={() => selected && void refresh(selected)}
            disabled={!selected || state.loading}
            className={cn(
              "rounded p-1 text-muted-foreground hover:text-foreground disabled:opacity-40",
            )}
            title={t("schema.refresh")}
          >
            {state.loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
        <div className="mt-1.5 text-[10px] text-muted-foreground">
          {!selected
            ? t("schema.addConnectionHint")
            : state.error
              ? t("schema.refreshFailed")
              : t("schema.summary", {
                  databases: state.groups.length,
                  tables: totalTables,
                })}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {state.error ? (
          <div className="px-3 py-2 text-[11px] text-destructive">
            {state.error}
          </div>
        ) : null}
        {!state.error && !state.loading && state.groups.length === 0 && selected ? (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            {t("schema.empty")}
          </div>
        ) : null}
        {state.groups.map((group) => {
          const key = group.db ?? "__no_db__";
          const isCollapsed = collapsed.has(key);
          const groupLabel = group.db ?? t("schema.noDatabase");
          return (
            <div key={key} className="border-b border-border/60">
              <button
                type="button"
                onClick={() => toggleGroup(key)}
                className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-[11px] hover:bg-sidebar-hover"
                title={groupLabel}
              >
                {isCollapsed ? (
                  <ChevronRight className="h-3 w-3 text-muted-foreground" />
                ) : (
                  <ChevronDown className="h-3 w-3 text-muted-foreground" />
                )}
                <Database className="h-3 w-3 text-muted-foreground" />
                <span className="truncate font-medium">{groupLabel}</span>
                <span className="ml-auto text-[10px] text-muted-foreground">
                  {group.tables.length}
                </span>
              </button>
              {!isCollapsed
                ? group.tables.map((table) => {
                    const qualified = tableKey(group.db, table);
                    const colState =
                      columnsByTable[qualified] ?? null;
                    const expanded = colState !== null;
                    return (
                      <TableRow
                        key={qualified}
                        tableName={table}
                        qualified={qualified}
                        expanded={expanded}
                        colState={colState ?? INITIAL_COL_STATE}
                        flash={flash}
                        onToggle={() => toggleTable(group.db, table)}
                        onCopy={onCopy}
                        t={t}
                      />
                    );
                  })
                : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TableRow({
  tableName,
  qualified,
  expanded,
  colState,
  flash,
  onToggle,
  onCopy,
  t,
}: {
  tableName: string;
  qualified: string;
  expanded: boolean;
  colState: ColumnState;
  flash: string | null;
  onToggle: () => void;
  onCopy: (label: string, text: string) => void | Promise<void>;
  t: ReturnType<typeof useT>;
}) {
  const copyNameKey = `name:${qualified}`;
  const copySelectKey = `select:${qualified}`;
  const selectStmt = `SELECT *\nFROM ${qualified}\nLIMIT 100`;
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-1.5 px-3 py-0.5 pl-5 text-left text-[11px] hover:bg-sidebar-hover"
        title={qualified}
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3 w-3 text-muted-foreground" />
        )}
        <TableIcon className="h-3 w-3 flex-none text-muted-foreground" />
        <span className="flex-1 truncate font-mono">{tableName}</span>
      </button>
      {expanded ? (
        <div className="border-l-2 border-border/60 bg-muted/30 px-3 py-1.5 ml-7 mr-2 mb-1 text-[11px]">
          {colState.loading ? (
            <div className="flex items-center gap-1 text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              <span>{t("schema.loadingColumns")}</span>
            </div>
          ) : colState.error ? (
            <div className="text-[10.5px] text-destructive">
              {colState.error}
            </div>
          ) : colState.columns && colState.columns.length > 0 ? (
            <ul className="space-y-0.5 font-mono">
              {colState.columns.map((c) => (
                <li
                  key={c.name}
                  className="flex items-baseline gap-2"
                  title={`${c.name} : ${c.typeName}`}
                >
                  <span className="truncate text-foreground/90">{c.name}</span>
                  <span className="ml-auto truncate text-[10px] text-muted-foreground">
                    {c.typeName}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="text-muted-foreground">{t("schema.noColumns")}</div>
          )}

          <div className="mt-1.5 flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => void onCopy(copyNameKey, qualified)}
              className="inline-flex items-center gap-1 rounded border border-border bg-background px-1.5 py-0.5 text-[10px] hover:bg-accent"
              title={t("schema.copyQualifiedNameTitle")}
            >
              <Copy className="h-3 w-3" />
              {flash === copyNameKey ? t("common.copied") : t("schema.copyName")}
            </button>
            <button
              type="button"
              onClick={() => void onCopy(copySelectKey, selectStmt)}
              className="inline-flex items-center gap-1 rounded border border-border bg-background px-1.5 py-0.5 text-[10px] hover:bg-accent"
              title={selectStmt}
            >
              <FileCode className="h-3 w-3" />
              {flash === copySelectKey ? t("common.copied") : t("schema.copySelect")}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
