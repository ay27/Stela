/**
 * MCP tab：Stela MCP server 的状态总览 + Claude Desktop / Cursor 接入说明。
 *
 * 注意：Stela 的 MCP server 是**独立的 Node CLI**（由外部 LLM 客户端 spawn），
 * 不由 Electron 主进程托管生命周期。所以这里的 Start / Stop 按钮只跑一次
 * 健康检查（spawn → ready → exit），帮用户验证可执行入口与依赖完好。
 *
 * 展示项：
 *   - 健康检查状态徽标 + 工具数
 *   - 一键复制 mcp config snippet（粘到 claude_desktop_config.json 即可）
 *   - 最近日志（最多 200 行）+ 清空按钮
 */

import { Copy, Loader2, PlayCircle, RefreshCw, StopCircle, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useMcp } from "@/state/mcp";
import { useT } from "@/i18n/use-t";

import { FormHint, Row, Section, TabContainer } from "./atoms";

const STATE_LABEL: Record<string, { text: string; tone: string }> = {
  stopped: { text: "Stopped", tone: "text-muted-foreground" },
  starting: { text: "Starting…", tone: "text-blue-600 dark:text-blue-400" },
  running: { text: "Healthy", tone: "text-emerald-600 dark:text-emerald-400" },
  stopping: { text: "Stopping…", tone: "text-amber-600 dark:text-amber-400" },
  errored: { text: "Error", tone: "text-destructive" },
};

export function McpTab() {
  const t = useT();
  const status = useMcp((s) => s.status);
  const logs = useMcp((s) => s.logs);
  const snippet = useMcp((s) => s.snippet);
  const loading = useMcp((s) => s.loading);
  const error = useMcp((s) => s.error);
  const refreshStatus = useMcp((s) => s.refreshStatus);
  const refreshLogs = useMcp((s) => s.refreshLogs);
  const refreshSnippet = useMcp((s) => s.refreshSnippet);
  const start = useMcp((s) => s.start);
  const stop = useMcp((s) => s.stop);
  const clearLogs = useMcp((s) => s.clearLogs);

  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void refreshStatus();
    void refreshLogs();
    void refreshSnippet();
    const id = window.setInterval(() => {
      void refreshStatus();
      void refreshLogs();
    }, 4_000);
    return () => window.clearInterval(id);
  }, [refreshLogs, refreshSnippet, refreshStatus]);

  const stateMeta = STATE_LABEL[status.state] ?? STATE_LABEL.stopped!;

  const onCopySnippet = async () => {
    if (!snippet) return;
    try {
      await navigator.clipboard.writeText(snippet.json);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      window.stela.shell.writeClipboardText(snippet.json);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }
  };

  const argsPretty = useMemo(
    () => snippet?.args.join(" ") ?? "",
    [snippet?.args],
  );

  return (
    <TabContainer>
      <Section
        title={t("mcp.title")}
        description={t("mcp.description")}
      >
        <Row
          label={t("mcp.health")}
          description={
            status.lastError
              ? t("mcp.lastError", { message: status.lastError })
              : status.state === "running"
                ? t("mcp.tools", { count: status.toolCount })
                : t("mcp.checkHint")
          }
        >
          <span className={stateMeta.tone + " text-xs"}>{stateMeta.text}</span>
        </Row>

        <Row label={t("mcp.actions")} description={t("mcp.actions.description")}>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              disabled={loading || status.state === "running"}
              onClick={() => void start()}
              className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1 text-xs hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading && status.state === "starting" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <PlayCircle className="h-3.5 w-3.5" />
              )}
              Run check
            </button>
            <button
              type="button"
              disabled={loading || status.state !== "running"}
              onClick={() => void stop()}
              className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1 text-xs hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
            >
              <StopCircle className="h-3.5 w-3.5" />
              Stop
            </button>
            <button
              type="button"
              onClick={() => {
                void refreshStatus();
                void refreshLogs();
                void refreshSnippet();
              }}
              className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1 text-xs hover:bg-accent"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Refresh
            </button>
          </div>
        </Row>
        {error ? <FormHint>{error}</FormHint> : null}
      </Section>

      <Section
        title={t("mcp.config.title")}
        description={t("mcp.config.description")}
      >
        {snippet ? (
          <>
            <div className="rounded-md border border-border bg-card/40 p-3">
              <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-foreground">
                {snippet.json}
              </pre>
              <div className="mt-2 flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
                <span className="truncate" title={`${snippet.command} ${argsPretty}`}>
                  command: <span className="font-mono">{snippet.command}</span>
                </span>
                <button
                  type="button"
                  onClick={() => void onCopySnippet()}
                  className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[10px] hover:bg-accent"
                >
                  <Copy className="h-3 w-3" />
                  {copied ? t("common.copied") : t("mcp.copyJson")}
                </button>
              </div>
            </div>
          </>
        ) : (
          <FormHint>{t("mcp.loadingSnippet")}</FormHint>
        )}
      </Section>

      <Section
        title={t("mcp.logs.title")}
        description={t("mcp.logs.description", { count: logs.length })}
      >
        <Row label={t("mcp.logs.label")} description={t("mcp.logs.rowDescription")}>
          <button
            type="button"
            onClick={() => void clearLogs()}
            className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1 text-xs hover:bg-accent"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t("mcp.logs.clear")}
          </button>
        </Row>
        <div className="max-h-72 overflow-auto rounded-md border border-border bg-card/40 p-2 font-mono text-[11px]">
          {logs.length === 0 ? (
            <div className="px-1 py-1 text-muted-foreground">
              {t("mcp.logs.empty")}
            </div>
          ) : (
            logs.map((line, i) => (
              <div
                key={i}
                className="whitespace-pre-wrap break-all border-b border-border/40 px-1 py-0.5 last:border-b-0"
              >
                {line}
              </div>
            ))
          )}
        </div>
      </Section>
    </TabContainer>
  );
}
