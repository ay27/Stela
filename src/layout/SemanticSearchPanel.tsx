/**
 * 语义搜索面板（v0.4）。
 *
 * 与 [`SearchPanel`](./SearchPanel.tsx) 平级，区别：
 *   - 走 hybrid retriever（dense + BM25 + RRF）
 *   - 命中是 chunk 而非 line，列表项展示 heading + snippet + score
 *   - 顶部展示 status banner：模型 / embedding 可用性 / 索引进度
 *   - 点击命中：openFile(path) + 跳到 heading slug（若有）
 */

import {
  Loader2,
  Sparkles,
  ChevronDown,
  ChevronRight,
  Settings as SettingsIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type {
  KnowledgeSearchHit,
  KnowledgeSearchMode,
} from "@shared/types";

import { cn } from "@/lib/utils";
import { useDialogs } from "@/state/dialogs";
import { useKnowledge } from "@/state/knowledge";
import { useLayout } from "@/state/layout";
import { useWorkspace } from "@/state/workspace";

interface Props {
  vaultPath: string;
}

const DEBOUNCE_MS = 350;

export function SemanticSearchPanel({ vaultPath }: Props) {
  const openFile = useWorkspace((s) => s.openFile);
  const openSettingsDialog = useDialogs((s) => s.setSettings);
  const hits = useKnowledge((s) => s.hits);
  const loading = useKnowledge((s) => s.loading);
  const error = useKnowledge((s) => s.error);
  const status = useKnowledge((s) => s.status);
  const search = useKnowledge((s) => s.search);
  const mode = useKnowledge((s) => s.mode);
  const setMode = useKnowledge((s) => s.setMode);
  const refreshStatus = useKnowledge((s) => s.refreshStatus);

  const knowledgeEnabled = status.enabled;

  const [keyword, setKeyword] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const inputRef = useRef<HTMLInputElement>(null);
  const focusToken = useLayout((s) => s.semanticFocusToken);
  useEffect(() => {
    if (!knowledgeEnabled) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusToken, knowledgeEnabled]);

  // 启动 / 切 vault 时刷新一次状态；关闭时只拉一次（status 是冷数据）
  useEffect(() => {
    void refreshStatus();
    if (!knowledgeEnabled) return;
    const id = window.setInterval(() => {
      void refreshStatus();
    }, 4_000);
    return () => window.clearInterval(id);
  }, [refreshStatus, vaultPath, knowledgeEnabled]);

  // 输入防抖；关闭时不发 search（main 端也会返回空，这里短路省一次 IPC）
  useEffect(() => {
    if (!knowledgeEnabled) return;
    const handle = window.setTimeout(() => {
      void search(keyword, { mode });
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [keyword, mode, search, knowledgeEnabled]);

  const grouped = useMemo(() => groupByPath(hits), [hits]);

  if (!knowledgeEnabled) {
    return (
      <div className="flex h-full flex-col">
        <div className="border-b border-border px-2.5 py-2">
          <div className="flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2 py-1 opacity-60">
            <Sparkles className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="flex-1 truncate py-0.5 text-[13px] text-muted-foreground">
              语义检索已关闭
            </span>
          </div>
        </div>
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <div className="text-[12px] text-muted-foreground">
            知识库（RAG）目前是关闭状态。
          </div>
          <div className="text-[11px] leading-relaxed text-muted-foreground">
            开启后会加载本地嵌入模型并建立 .stela-knowledge.sqlite 索引，
            提供 hybrid 语义检索。已构建的索引在关闭期间不会被删除。
          </div>
          <button
            type="button"
            onClick={() => openSettingsDialog(true)}
            className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1 text-[12px] hover:bg-accent"
          >
            <SettingsIcon className="h-3.5 w-3.5" />
            打开设置 → Knowledge
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-2.5 py-2">
        <div className="flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 focus-within:border-primary">
          <Sparkles className="h-3.5 w-3.5 text-muted-foreground" />
          <input
            ref={inputRef}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="自然语言检索（dense + BM25）…"
            className="flex-1 bg-transparent py-0.5 text-[13px] focus:outline-none"
          />
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
          ) : null}
        </div>
        <div className="mt-1.5 flex items-center justify-between text-[10px] text-muted-foreground">
          <span>
            {keyword.trim() === ""
              ? "Mod+Shift+K 唤起 · 输入开始检索"
              : `${hits.length} 条命中 · ${grouped.length} 个文件`}
          </span>
          <ModePicker value={mode} onChange={setMode} />
        </div>
        <StatusBanner />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <div className="px-3 py-3 text-xs text-destructive">{error}</div>
        ) : null}
        {!error && keyword.trim() && !loading && hits.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            没有命中
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
                <span className="truncate font-medium">{items[0]!.title}</span>
                <span
                  className="ml-1 truncate text-[10px] text-muted-foreground"
                  title={path}
                >
                  {items[0]!.relPath}
                </span>
                <span className="ml-auto text-[10px] text-muted-foreground">
                  {items.length}
                </span>
              </button>
              {!isCollapsed
                ? items.map((hit) => (
                    <HitRow
                      key={hit.chunkId}
                      hit={hit}
                      onOpen={() =>
                        openFile(hit.sourcePath, {
                          scrollToSlug: hit.headingSlug ?? undefined,
                        })
                      }
                    />
                  ))
                : null}
            </div>
          );
        })}
      </div>
    </div>
  );

  function StatusBanner() {
    if (!status.ready) return null;
    if (!status.embeddingsAvailable) {
      return (
        <div className="mt-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[10px] text-amber-900 dark:text-amber-200">
          embedding 模型不可用，已降级为 BM25-only。
          {status.lastError ? ` · ${status.lastError}` : ""}
        </div>
      );
    }
    if (status.indexing) {
      return (
        <div className="mt-1 rounded-md border border-blue-500/40 bg-blue-500/10 px-2 py-1 text-[10px] text-blue-900 dark:text-blue-200">
          索引构建中：剩 {status.pendingSources} 篇 · {status.totalChunks} chunks
        </div>
      );
    }
    return null;
  }
}

function HitRow({
  hit,
  onOpen,
}: {
  hit: KnowledgeSearchHit;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full flex-col gap-0.5 px-3 py-1.5 text-left text-[11px] hover:bg-sidebar-hover"
    >
      <div className="flex items-center gap-1.5">
        {hit.sourceKind === "runsql" ? (
          <span className="rounded bg-purple-500/15 px-1 py-px font-mono text-[9px] uppercase text-purple-700 dark:text-purple-300">
            sql
          </span>
        ) : null}
        {hit.headingText ? (
          <span className="truncate font-medium text-foreground/90">
            {hit.headingText}
          </span>
        ) : null}
        <span
          className="ml-auto font-mono text-[10px] text-muted-foreground"
          title={`distance=${hit.distance ?? "·"} bm25=${hit.bm25 ?? "·"}`}
        >
          {hit.score.toFixed(3)}
        </span>
      </div>
      <span className="break-all text-muted-foreground">{hit.snippet}</span>
    </button>
  );
}

function ModePicker({
  value,
  onChange,
}: {
  value: KnowledgeSearchMode;
  onChange: (m: KnowledgeSearchMode) => void;
}) {
  const opts: Array<{ id: KnowledgeSearchMode; label: string }> = [
    { id: "hybrid", label: "Hybrid" },
    { id: "dense", label: "Dense" },
    { id: "keyword", label: "BM25" },
  ];
  return (
    <div className="flex gap-0.5">
      {opts.map((o) => (
        <button
          key={o.id}
          type="button"
          onClick={() => onChange(o.id)}
          className={cn(
            "rounded px-1.5 py-0.5 font-mono text-[10px]",
            value === o.id
              ? "bg-accent text-foreground"
              : "text-muted-foreground hover:bg-sidebar-hover",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function groupByPath(
  hits: KnowledgeSearchHit[],
): Array<{ path: string; items: KnowledgeSearchHit[] }> {
  const map = new Map<string, KnowledgeSearchHit[]>();
  for (const h of hits) {
    const arr = map.get(h.sourcePath);
    if (arr) arr.push(h);
    else map.set(h.sourcePath, [h]);
  }
  return Array.from(map.entries()).map(([path, items]) => ({ path, items }));
}
