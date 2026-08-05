/**
 * Schema 浏览器侧栏面板（v0.2 #4）。
 *
 * - 顶部：连接选择器（默认取当前编辑文件 frontmatter 的 connection_name）+ 刷新按钮
 * - 中部：按 db 折叠的 table 列表；HTTP 等无库 connector 退化为单组（标题 "(no database)"）
 * - 表节点保持单行，不在侧栏展开列名；表头右侧只保留 AI 入口。
 * - 错误：刷新失败时整体显示一行错误提示，不破坏已加载的旧数据
 */

import {
  ChevronDown,
  ChevronRight,
  Database,
  Loader2,
  RefreshCw,
  Sparkles,
  Table as TableIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { fetchSchemaGroups, type SchemaGroup } from "@/editor/runsql/fetch-schema";
import { useConnections } from "@/state/connections";
import { useWorkspace } from "@/state/workspace";
import { getRunContext } from "@/editor/runsql/run-context";
import { useT } from "@/i18n/use-t";
import { cn } from "@/lib/utils";
import { openAiModal } from "@/state/ai-modal";

interface SchemaState {
  loading: boolean;
  error: string | null;
  groups: SchemaGroup[];
}

const INITIAL_STATE: SchemaState = {
  loading: false,
  error: null,
  groups: [],
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

  const tableKey = (db: string | null, table: string) =>
    db ? `${db}.${table}` : table;

  const onAi = (qualified: string) => {
    const title = t("ai.action.explain-table");
    const [database, table] = qualified.includes(".")
      ? qualified.split(/\.(.+)/).slice(0, 2)
      : [null, qualified];
    openAiModal({
      title,
      request: {
        action: "explain-table",
        context: {
          source: "schema",
          connectionName: selected,
          schema: { connectionName: selected, database, table, columns: [] },
        },
      },
    });
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
                    return (
                      <TableRow
                        key={qualified}
                        tableName={table}
                        qualified={qualified}
                        onAi={onAi}
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
  onAi,
  t,
}: {
  tableName: string;
  qualified: string;
  onAi: (qualified: string) => void;
  t: ReturnType<typeof useT>;
}) {
  return (
    <div
      className="flex w-full items-center gap-1.5 px-3 py-0.5 pl-7 text-left text-[11px] hover:bg-sidebar-hover"
      title={qualified}
    >
      <TableIcon className="h-3 w-3 flex-none text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate font-mono">{tableName}</span>
      <button
        type="button"
        onClick={() => onAi(qualified)}
        className="inline-flex flex-none items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
        title={t("ai.action.explainTable")}
      >
        <Sparkles className="h-3 w-3" />
        AI
      </button>
    </div>
  );
}
