import { useEffect, useRef, useState } from "react";
import {
  Bot,
  CheckCircle2,
  ChevronDown,
  Loader2,
  PanelRightClose,
  Plus,
  Send,
  ShieldAlert,
  StopCircle,
  XCircle,
} from "lucide-react";

import { i18n } from "@/i18n";
import { useT } from "@/i18n/use-t";
import { cn } from "@/lib/utils";
import { getRunContext } from "@/editor/runsql/run-context";
import { useAgentPanel, type AgentTimelineEntry } from "@/state/agent-panel";
import { useLayout } from "@/state/layout";
import { useConnections } from "@/state/connections";
import { firstConnectionName } from "@/services/connections";
import { ConnectionPicker } from "@/components/connection-picker";

import { renderMarkdown } from "./ai-modal";

/**
 * 应用级全局 Agent 面板主体，嵌在 [AgentSidebar](../../layout/AgentSidebar.tsx)
 * 里——一条独立于左侧文件树 / 文档目录的常驻右侧栏，视觉上用边框跟文档区分开，
 * 强调它是"全局"而非"当前文档"范畴的工具。
 */
export function AgentPanel() {
  const t = useT();
  const status = useAgentPanel((s) => s.status);
  const timeline = useAgentPanel((s) => s.timeline);
  const focusToken = useLayout((s) => s.agentFocusToken);
  const toggleAgentPanel = useLayout((s) => s.toggleAgentPanel);
  const start = useAgentPanel((s) => s.start);
  const cancel = useAgentPanel((s) => s.cancel);
  const respondProposal = useAgentPanel((s) => s.respondProposal);
  const newConversation = useAgentPanel((s) => s.newConversation);

  const [prompt, setPrompt] = useState("");
  const [connectionName, setConnectionName] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const busy = status === "running";

  const connectionEntries = useConnections((s) => s.entries);
  const connectionsLoaded = useConnections((s) => s.loaded);
  const reloadConnections = useConnections((s) => s.reload);

  useEffect(() => {
    if (!connectionsLoaded) void reloadConnections();
  }, [connectionsLoaded, reloadConnections]);

  // 当前文档的连接 > 默认连接（isDefault 标记 / 名称首个）> 空。与
  // EditorView 的 frontmatter 兜底规则保持一致，避免多连接时每次都要手选。
  useEffect(() => {
    if (connectionName !== null) return;
    const ctx = getRunContext();
    if (ctx?.connectionName) {
      setConnectionName(ctx.connectionName);
      return;
    }
    if (!connectionsLoaded) return;
    const fallback = firstConnectionName(connectionEntries);
    if (fallback) setConnectionName(fallback);
  }, [connectionName, connectionsLoaded, connectionEntries]);

  useEffect(() => {
    if (focusToken > 0) textareaRef.current?.focus();
  }, [focusToken]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [timeline]);

  const send = () => {
    const trimmed = prompt.trim();
    if (!trimmed || busy) return;
    const ctx = getRunContext();
    void start({
      prompt: trimmed,
      connectionName,
      notePath: ctx?.path ?? null,
      locale: i18n.resolvedLanguage?.startsWith("zh") ? "zh" : "en",
    });
    setPrompt("");
  };

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <div className="flex h-9 flex-none items-center gap-2 border-b border-border px-2.5">
        <Bot className="h-3.5 w-3.5 flex-none text-primary" />
        <span className="flex-1 truncate text-[12px] font-medium">{t("agent.panel.title")}</span>
        <ConnectionPicker value={connectionName} onChange={setConnectionName} />
        <button
          type="button"
          onClick={newConversation}
          disabled={timeline.length === 0 && status === "idle"}
          className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
          title={t("agent.panel.newConversation")}
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={toggleAgentPanel}
          className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          title={t("agent.panel.collapse")}
        >
          <PanelRightClose className="h-3.5 w-3.5" />
        </button>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-2.5 overflow-auto px-2.5 py-2.5">
        {timeline.length === 0 ? (
          <div className="text-[12px] text-muted-foreground">{t("agent.panel.empty")}</div>
        ) : (
          timeline.map((entry) => (
            <TimelineItem key={entry.id} entry={entry} onRespond={respondProposal} />
          ))
        )}
        {busy ? (
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            {t("agent.panel.thinking")}
          </div>
        ) : null}
      </div>

      <div className="border-t border-border bg-muted/20 px-2 py-2">
        <textarea
          ref={textareaRef}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={t("agent.panel.placeholder")}
          rows={6}
          disabled={busy}
          className="w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 text-[12px] outline-none focus:border-primary disabled:opacity-60"
        />
        {/* 独立一行放操作按钮——未来还会加别的面板级功能按钮，Send/Stop 先占最右。 */}
        <div className="mt-1.5 flex items-center justify-end gap-1.5">
          {busy ? (
            <button
              type="button"
              onClick={() => void cancel()}
              className="inline-flex items-center gap-1 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-[11px] font-medium text-destructive hover:bg-destructive/20"
            >
              <StopCircle className="h-3.5 w-3.5" />
            </button>
          ) : (
            <button
              type="button"
              onClick={send}
              disabled={!prompt.trim()}
              className="inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1.5 text-[11px] font-medium text-primary-foreground disabled:opacity-40"
            >
              <Send className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function TimelineItem({
  entry,
  onRespond,
}: {
  entry: AgentTimelineEntry;
  onRespond: (callId: string, approve: boolean) => Promise<void>;
}) {
  const t = useT();
  switch (entry.kind) {
    case "user":
      return (
        <div className="flex justify-end">
          <div className="max-w-[80%] rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground">
            {entry.content}
          </div>
        </div>
      );
    case "assistant":
      return (
        <div className="stela-ai-markdown text-sm leading-6">{renderMarkdown(entry.content)}</div>
      );
    case "final":
      return (
        <div className="rounded-lg border border-border bg-card/40 p-3">
          <div className="stela-ai-markdown text-sm leading-6">{renderMarkdown(entry.content)}</div>
        </div>
      );
    case "error":
      return (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          {entry.message}
        </div>
      );
    case "cancelled":
      return <div className="text-xs italic text-muted-foreground">{t("agent.panel.cancelled")}</div>;
    case "tool":
      return <ToolChip entry={entry} />;
    case "proposal":
      return <ProposalCard entry={entry} onRespond={onRespond} />;
  }
}

function ToolChip({ entry }: { entry: Extract<AgentTimelineEntry, { kind: "tool" }> }) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const pending = !entry.result;
  const failed = entry.result && !entry.result.ok;
  return (
    <div className="rounded-md border border-border/60 bg-muted/20 text-xs">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left"
      >
        {pending ? (
          <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
        ) : failed ? (
          <XCircle className="h-3 w-3 text-destructive" />
        ) : (
          <CheckCircle2 className="h-3 w-3 text-primary" />
        )}
        <span className="font-mono">{entry.name}</span>
        <ChevronDown className={cn("ml-auto h-3 w-3 transition-transform", expanded && "rotate-180")} />
      </button>
      {expanded ? (
        <div className="space-y-2 border-t border-border/60 px-3 py-2 font-mono text-[11px] text-muted-foreground">
          <div>
            <div className="mb-1 text-foreground/70">{t("agent.panel.arguments")}</div>
            <pre className="overflow-auto whitespace-pre-wrap">{JSON.stringify(entry.args, null, 2)}</pre>
          </div>
          {entry.result ? (
            <div>
              <div className="mb-1 text-foreground/70">{t("agent.panel.result")}</div>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap">{entry.result.summary}</pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ProposalCard({
  entry,
  onRespond,
}: {
  entry: Extract<AgentTimelineEntry, { kind: "proposal" }>;
  onRespond: (callId: string, approve: boolean) => Promise<void>;
}) {
  const t = useT();
  const resolved = entry.resolution !== "pending";
  return (
    <div
      className={cn(
        "rounded-lg border p-3 text-sm",
        entry.resolution === "approved"
          ? "border-primary/40 bg-primary/5"
          : entry.resolution === "rejected"
            ? "border-border bg-muted/30"
            : "border-amber-400/50 bg-amber-400/10",
      )}
    >
      <div className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-amber-600">
        <ShieldAlert className="h-3.5 w-3.5" />
        {entry.proposalKind === "edit_note"
          ? t("agent.panel.proposal.edit")
          : t("agent.panel.proposal.sql")}
      </div>
      <div className="mb-2 text-foreground">{entry.payload.description}</div>
      {entry.payload.sql ? (
        <pre className="mb-2 overflow-auto rounded bg-muted p-2 font-mono text-[11px]">
          {entry.payload.sql}
        </pre>
      ) : null}
      {entry.payload.notePath ? (
        <div className="mb-2 text-[11px] text-muted-foreground">{entry.payload.notePath}</div>
      ) : null}
      {resolved ? (
        <div className="text-xs text-muted-foreground">
          {entry.resolution === "approved"
            ? t("agent.panel.proposal.approved")
            : t("agent.panel.proposal.rejected")}
        </div>
      ) : (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void onRespond(entry.callId, true)}
            className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground"
          >
            {t("agent.panel.proposal.approve")}
          </button>
          <button
            type="button"
            onClick={() => void onRespond(entry.callId, false)}
            className="rounded-md border border-border px-3 py-1 text-xs hover:bg-accent"
          >
            {t("agent.panel.proposal.reject")}
          </button>
        </div>
      )}
    </div>
  );
}
