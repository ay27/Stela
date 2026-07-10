import { useCallback, useEffect, useRef, useState, type WheelEvent } from "react";
import {
  Bot,
  CheckCircle2,
  ChevronDown,
  FileText,
  Loader2,
  MessageSquareQuote,
  Plus,
  Send,
  ShieldAlert,
  StopCircle,
  X,
  XCircle,
} from "lucide-react";
import type { AgentAttachment } from "@shared/types";
import type { MentionItem } from "@skyastrall/mentions-react";

import { i18n } from "@/i18n";
import { useT } from "@/i18n/use-t";
import { cn } from "@/lib/utils";
import { getRunContext } from "@/editor/runsql/run-context";
import {
  ensureAutocompleteFor,
  peekAutocompleteFor,
} from "@/editor/runsql/fetch-schema";
import {
  useAgentPanel,
  type AgentDraft,
  type AgentDraftAttachment,
  type AgentTimelineEntry,
} from "@/state/agent-panel";
import { useLayout } from "@/state/layout";
import { useConnections } from "@/state/connections";
import { useWorkspace } from "@/state/workspace";
import { firstConnectionName } from "@/services/connections";
import { ConnectionPicker } from "@/components/connection-picker";

import {
  AiPromptInput,
  type AiPromptInputHandle,
  type AiPromptSubmitPayload,
} from "./ai-prompt-input";
import { renderMarkdown } from "./ai-modal";

type AiPromptInputDraft = {
  text: string;
  mentionedTables: string[];
  referencedNotes: string[];
  isEmpty: boolean;
};

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function relativeToVault(path: string | null | undefined, vaultPath: string | null): string | null {
  if (!path) return null;
  if (!vaultPath) return path;
  const normalizedVault = vaultPath.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedPath = path.replace(/\\/g, "/");
  if (normalizedPath.startsWith(`${normalizedVault}/`)) {
    return normalizedPath.slice(normalizedVault.length + 1);
  }
  return normalizedPath;
}

function attachmentLabel(attachment: AgentDraftAttachment): string {
  switch (attachment.kind) {
    case "note":
      return attachment.path.split("/").pop() || attachment.path;
    case "runsql":
      return attachment.label;
    case "selection":
      return attachment.label;
  }
}

function attachmentTitle(attachment: AgentDraftAttachment): string {
  switch (attachment.kind) {
    case "note":
      return attachment.path;
    case "runsql":
      return attachment.sql;
    case "selection":
      return attachment.text;
  }
}

function mergePromptValue(draft: AgentDraft, value: AiPromptInputDraft): AgentDraft {
  const referencedNotes = uniqueStrings(value.referencedNotes);
  const existingNotePaths = new Set(
    draft.attachments
      .filter((item): item is Extract<AgentDraftAttachment, { kind: "note" }> => item.kind === "note")
      .map((item) => item.path),
  );
  const addedNotes: AgentDraftAttachment[] = referencedNotes
    .filter((path) => !existingNotePaths.has(path))
    .map((path) => ({
      id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      kind: "note",
      path,
    }));
  return {
    ...draft,
    text: value.text,
    mentionedTables: value.mentionedTables,
    attachments: [...draft.attachments, ...addedNotes],
    dismissedNotePaths: draft.dismissedNotePaths.filter((path) => !referencedNotes.includes(path)),
    isEmpty: value.isEmpty,
  };
}

/**
 * 应用级全局 Agent 面板主体，嵌在 [AgentSidebar](../../layout/AgentSidebar.tsx)
 * 里——一条独立于左侧文件树 / 文档目录的常驻右侧栏，视觉上用边框跟文档区分开，
 * 强调它是"全局"而非"当前文档"范畴的工具。
 */
export function AgentPanel() {
  const t = useT();
  const tabs = useAgentPanel((s) => s.tabs);
  const activeTabId = useAgentPanel((s) => s.activeTabId);
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];
  const status = activeTab.status;
  const timeline = activeTab.timeline;
  const draft = activeTab.draft;
  const resetToken = activeTab.resetToken;
  const connectionName = activeTab.connectionName;
  const vaultPath = useWorkspace((s) => s.vaultPath);
  const focusToken = useLayout((s) => s.agentFocusToken);
  const switchTab = useAgentPanel((s) => s.switchTab);
  const start = useAgentPanel((s) => s.start);
  const cancel = useAgentPanel((s) => s.cancel);
  const respondProposal = useAgentPanel((s) => s.respondProposal);
  const newConversation = useAgentPanel((s) => s.newConversation);
  const closeTab = useAgentPanel((s) => s.closeTab);
  const setConnectionName = useAgentPanel((s) => s.setConnectionName);
  const updateDraft = useAgentPanel((s) => s.updateDraft);
  const removeAttachment = useAgentPanel((s) => s.removeAttachment);
  const ensureDefaultNote = useAgentPanel((s) => s.ensureDefaultNote);
  const scrollRef = useRef<HTMLDivElement>(null);
  const promptInputRef = useRef<AiPromptInputHandle>(null);
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
  }, [activeTabId, connectionName, connectionsLoaded, connectionEntries, setConnectionName]);

  useEffect(() => {
    if (focusToken > 0) promptInputRef.current?.focus();
  }, [focusToken]);

  useEffect(() => {
    ensureDefaultNote(relativeToVault(getRunContext()?.path, vaultPath));
  }, [activeTabId, focusToken, vaultPath, ensureDefaultNote]);

  const getTableNamesCached = useCallback(
    () => (connectionName ? peekAutocompleteFor(connectionName) : []),
    [connectionName],
  );
  const getTableNames = useCallback(
    () =>
      connectionName ? ensureAutocompleteFor(connectionName) : Promise.resolve([]),
    [connectionName],
  );
  const getNoteCandidates = useCallback(async (query: string): Promise<MentionItem[]> => {
    const candidates = await window.stela.index.listCandidates(query, 24);
    return candidates
      .filter((candidate) => candidate.kind === "file" && candidate.detail)
      .slice(0, 12)
      .map((candidate) => ({
        id: candidate.detail,
        label: candidate.detail,
      }));
  }, []);

  const onWheelScroll = useCallback((ev: WheelEvent<HTMLDivElement>) => {
    if (ev.deltaX === 0 && ev.deltaY !== 0) {
      ev.currentTarget.scrollLeft += ev.deltaY;
    }
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [activeTabId, timeline]);

  const send = ({ text, mentionedTables, referencedNotes }: AiPromptSubmitPayload) => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    const ctx = getRunContext();
    const notePaths = uniqueStrings([
      ...draft.attachments.filter((item): item is Extract<AgentDraftAttachment, { kind: "note" }> => item.kind === "note").map((item) => item.path),
      ...referencedNotes,
    ]);
    const contentAttachments = draft.attachments
      .filter((item): item is Extract<AgentDraftAttachment, { kind: "selection" | "runsql" }> => item.kind !== "note")
      .map((attachment): AgentAttachment =>
        attachment.kind === "runsql"
          ? {
              kind: "runsql",
              label: attachment.label,
              sql: attachment.sql,
              sourcePath: attachment.sourcePath,
            }
          : {
              kind: "selection",
              label: attachment.label,
              text: attachment.text,
              sourcePath: attachment.sourcePath,
            },
      );
    void start({
      prompt: trimmed,
      mentionedTables: mentionedTables.length > 0 ? mentionedTables : undefined,
      referencedNotes: notePaths.length > 0 ? notePaths : undefined,
      attachments: contentAttachments.length > 0 ? contentAttachments : undefined,
      connectionName,
      notePath: ctx?.path ?? null,
      locale: i18n.resolvedLanguage?.startsWith("zh") ? "zh" : "en",
    });
  };

  const updatePromptDraft = useCallback(
    (value: AiPromptInputDraft) => {
      updateDraft(mergePromptValue(draft, value));
    },
    [draft, updateDraft],
  );

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <div className="flex h-9 flex-none items-stretch border-b border-border bg-muted/60">
        <div className="stela-tabbar-scroll flex min-w-0 flex-1 items-stretch overflow-x-auto" onWheel={onWheelScroll}>
          {tabs.map((tab, idx) => {
            const active = tab.id === activeTabId;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => switchTab(tab.id)}
                className={cn(
                  "group relative flex min-w-[104px] max-w-[180px] shrink-0 cursor-pointer select-none items-center gap-2 px-3 text-[12px] transition-colors",
                  active
                    ? "bg-background text-foreground"
                    : "text-muted-foreground hover:bg-background/50 hover:text-foreground",
                  idx > 0 && !active && "border-l border-border",
                )}
                title={tab.title}
              >
                <span
                  className={cn(
                    "pointer-events-none absolute inset-x-0 bottom-0 h-[2px]",
                    active ? "bg-primary" : "bg-transparent",
                  )}
                />
                {tab.status === "running" ? (
                  <Loader2 className="h-3 w-3 flex-none animate-spin text-primary" />
                ) : (
                  <Bot className="h-3.5 w-3.5 flex-none text-muted-foreground" />
                )}
                <span className="flex-1 truncate">{tab.title}</span>
                {tabs.length > 1 ? (
                  <span
                    role="button"
                    tabIndex={-1}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      closeTab(tab.id);
                    }}
                    className={cn(
                      "flex h-4 w-4 flex-none items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground",
                      active ? "opacity-100" : "opacity-0 group-hover:opacity-100",
                    )}
                    title={t("agent.panel.closeTab")}
                  >
                    <X className="h-3 w-3" />
                  </span>
                ) : null}
              </button>
            );
          })}
          <div className="flex-1 border-b border-border/0" />
        </div>
        <button
          type="button"
          onClick={newConversation}
          className="flex w-8 flex-none items-center justify-center border-l border-border text-muted-foreground hover:bg-background/50 hover:text-foreground"
          title={t("agent.panel.newConversation")}
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex h-8 flex-none items-center gap-2 border-b border-border bg-muted/20 px-2.5">
        <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-[12px] font-medium text-muted-foreground">
          <Bot className="h-3.5 w-3.5 flex-none text-primary" />
          {t("agent.panel.title")}
        </span>
        <ConnectionPicker value={connectionName} onChange={setConnectionName} />
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
        <AiPromptInput
          key={activeTabId}
          ref={promptInputRef}
          resetToken={resetToken}
          initialValue={draft.text}
          placeholder={t("agent.panel.placeholder")}
          disabled={busy}
          minHeightPx={132}
          getTableNamesCached={getTableNamesCached}
          getTableNames={getTableNames}
          getNoteCandidates={getNoteCandidates}
          onChange={updatePromptDraft}
          onSubmit={send}
        />
        <AttachmentChips attachments={draft.attachments} onRemove={removeAttachment} />
        {/* 独立一行放操作按钮——未来还会加别的面板级功能按钮，Send/Stop 先占最右。 */}
        <div className="mt-1.5 flex items-center justify-end gap-1.5">
          {busy ? (
            <button
              type="button"
              onClick={() => void cancel()}
              title={t("agent.panel.cancel")}
              className="inline-flex items-center gap-1 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-[11px] font-medium text-destructive hover:bg-destructive/20"
            >
              <StopCircle className="h-3.5 w-3.5" />
            </button>
          ) : (
            <button
              type="button"
              onClick={() =>
                send({ text: draft.text, mentionedTables: draft.mentionedTables, referencedNotes: [] })
              }
              disabled={draft.isEmpty}
              title={t("agent.panel.send")}
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

function AttachmentChips({
  attachments,
  onRemove,
}: {
  attachments: AgentDraftAttachment[];
  onRemove: (attachmentId: string) => void;
}) {
  if (attachments.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      {attachments.map((attachment) => (
        <span
          key={attachment.id}
          title={attachmentTitle(attachment)}
          className="inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-background px-1.5 py-1 text-[11px] text-muted-foreground"
        >
          {attachment.kind === "note" ? (
            <FileText className="h-3 w-3 flex-none text-primary" />
          ) : (
            <MessageSquareQuote className="h-3 w-3 flex-none text-primary" />
          )}
          <span className="max-w-[180px] truncate">{attachmentLabel(attachment)}</span>
          <button
            type="button"
            onClick={() => onRemove(attachment.id)}
            className="ml-0.5 rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="Remove chat attachment"
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
    </div>
  );
}

function TimelineItem({
  entry,
  onRespond,
}: {
  entry: AgentTimelineEntry;
  onRespond: (runId: string, callId: string, approve: boolean) => Promise<void>;
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
  onRespond: (runId: string, callId: string, approve: boolean) => Promise<void>;
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
      {entry.payload.oldContent || entry.payload.newContent ? (
        <div className="mb-2 grid gap-2 text-[11px] md:grid-cols-2">
          <div>
            <div className="mb-1 font-medium text-muted-foreground">{t("agent.panel.proposal.before")}</div>
            <pre className="max-h-48 overflow-auto rounded bg-muted p-2 font-mono">
              {entry.payload.oldContent ?? ""}
            </pre>
          </div>
          <div>
            <div className="mb-1 font-medium text-muted-foreground">{t("agent.panel.proposal.after")}</div>
            <pre className="max-h-48 overflow-auto rounded bg-muted p-2 font-mono">
              {entry.payload.newContent ?? ""}
            </pre>
          </div>
        </div>
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
            onClick={() => void onRespond(entry.runId, entry.callId, true)}
            className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground"
          >
            {t("agent.panel.proposal.approve")}
          </button>
          <button
            type="button"
            onClick={() => void onRespond(entry.runId, entry.callId, false)}
            className="rounded-md border border-border px-3 py-1 text-xs hover:bg-accent"
          >
            {t("agent.panel.proposal.reject")}
          </button>
        </div>
      )}
    </div>
  );
}
