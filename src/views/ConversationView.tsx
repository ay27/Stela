import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bot, Loader2, RotateCcw, Copy, Pencil, ChevronRight } from "lucide-react";
import { useConversation } from "@/state/conversation";
import { useConnections } from "@/state/connections";
import { useWorkspace } from "@/state/workspace";
import { AgentTimelineContent, AgentThinkingStatus, AgentComposerActions, AgentBlankIllustration, QuestionCard, TimelineItem, openAgentResource } from "@/components/ai/agent-panel";
import { conversationTimeline, conversationResults } from "@/components/ai/conversation-timeline";
import { AiPromptInput } from "@/components/ai/ai-prompt-input";
import { agentComposerStateToMessage, emptyAgentComposerState } from "@/lib/agent-composer";
import { agentMessagePlainText } from "@shared/agent-message";
import { PythonWorkspaceStatus } from "@/components/ai/python-workspace-status";
import { ContextUsageIndicator } from "@/components/ai/context-usage-indicator";
import { ConnectionPicker } from "@/components/connection-picker";
import { firstConnectionName } from "@/services/connections";
import { BlockResult } from "@/components/block-result";
import type { RunRecord } from "@shared/types";
import type { ConversationTurn } from "@shared/conversation";
import { useT } from "@/i18n/use-t";

type Respond = (runId: string, callId: string, approve: boolean, answer?: string) => Promise<void>;

function SqlResult({ run, reuse, number }: { run: RunRecord; reuse: (text: string) => void; number?: number }) {
  const t = useT();
  const [expanded, setExpanded] = useState(true);
  const [showSql, setShowSql] = useState(false);
  return (
    <div className="stela-assistant-output stela-conversation-result min-w-0 py-1">
      <div className="mb-1 text-sm font-medium">{t("agent.reply.queryResult")}{number ? ` ${number}` : ""}</div>
      <div className="flex items-center gap-1 pb-2 text-[11px] text-muted-foreground">
        <button type="button" aria-expanded={showSql} onClick={() => setShowSql(!showSql)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left hover:text-foreground">
          <ChevronRight className={`h-3 w-3 transition-transform ${showSql ? "rotate-90" : ""}`} />
          <span>{t("agent.reply.viewSql")}</span><span className="truncate opacity-60">· {run.connectionName}</span>
        </button>
        <button title={t("conversation.copySql")} aria-label={t("conversation.copySql")} className="rounded p-1 hover:bg-muted hover:text-foreground" onClick={() => void navigator.clipboard.writeText(run.sql)}><Copy className="h-3 w-3" /></button>
        <button title={t("conversation.reuse")} aria-label={t("conversation.reuse")} className="rounded p-1 hover:bg-muted hover:text-foreground" onClick={() => reuse(run.sql)}><Pencil className="h-3 w-3" /></button>
      </div>
      {showSql && <pre className="overflow-x-auto whitespace-pre-wrap rounded-md bg-muted/30 p-3 mb-2 text-xs leading-5">{run.sql}</pre>}
      <BlockResult runId={run.status === "ok" ? run.runId : null} blockId={run.blockId} detail={null} runState={run.status === "running" ? "running" : run.status === "err" ? "error" : "idle"} errorMessage={run.message} expanded={expanded} onToggle={() => setExpanded(value => !value)} />
      {run.status === "ok" && run.message && <div className="py-2 text-sm leading-6">{run.message}</div>}
    </div>
  );
}

const Turn = memo(function Turn({ turn, reuse, onRespond }: { turn: ConversationTurn; reuse: (text: string) => void; onRespond: Respond }) {
  const t = useT();
  const timeline = useMemo(() => conversationTimeline(turn), [turn]);
  const results = useMemo(() => conversationResults(turn, timeline), [turn, timeline]);
  const final = timeline.findLast(entry => entry.kind === "final");
  // The final answer already owns its Markdown tables. Otherwise promote just the
  // latest successful result; exploratory runs remain available in the disclosure.
  const primary = final?.kind === "final" && !/^\s*\|.+\|\s*$/m.test(final.content)
    ? turn.runs.findLast(run => run.status === "ok") : undefined;
  const extraRuns = [...results.before, ...results.after].filter(run => run.runId !== primary?.runId);
  const detailsResult = (run: RunRecord) => run.runId === primary?.runId ? null : renderResult(run);
  const renderResult = (run: RunRecord) => <SqlResult key={run.runId} run={run} reuse={reuse} number={turn.runs.length > 1 ? turn.runs.findIndex(item => item.runId === run.runId) + 1 : undefined} />;
  return (
    <article className="stela-conversation-turn">
      <TimelineItem entry={{ kind: "user", id: turn.id, message: turn.message ?? { version: 1, segments: [{ kind: "text", text: turn.input }], resources: [] } }} onRespond={onRespond} />
      {!timeline.length && results.before.map(renderResult)}
      <AgentTimelineContent timeline={timeline} busy={turn.status === "running"} onRespond={onRespond} executionContent={timeline.length && extraRuns.length ? extraRuns.map(renderResult) : undefined} afterEntry={entry => entry.id === final?.id && primary ? renderResult(primary) : results.byEntry.get(entry.id)?.map(detailsResult)} />
      {!timeline.length && results.after.map(renderResult)}
      {!timeline.length && turn.status === "running" && <AgentThinkingStatus />}
      {turn.error && !timeline.some(entry => entry.kind === "error") && <p role="alert" className="text-xs text-destructive">{turn.error}</p>}
      {turn.status === "interrupted" && <p className="text-xs text-muted-foreground">{t("conversation.interrupted")}</p>}
      {turn.status === "cancelled" && !timeline.some(entry => entry.kind === "cancelled") && <p className="text-xs text-muted-foreground">{t("agent.panel.cancelled")}</p>}
    </article>
  );
});

export function ConversationView({ path, tabId }: { path: string; tabId: string }) {
  const t = useT();
  const store = useConversation();
  const snapshot = store.snapshots[path];
  const entries = useConnections(s => s.entries);
  const connectionsLoaded = useConnections(s => s.loaded);
  const emptyEditor = useMemo(() => emptyAgentComposerState(), [path]);
  const editorState = store.editors[path] ?? emptyEditor;
  const draft = store.drafts[path] ?? "";
  const connectionName = store.connections[path] ?? null;
  const reloadToken = useWorkspace(s => s.tabs.find(tab => tab.id === tabId)?.reloadToken);
  const [error, setError] = useState("");
  const scroll = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  useEffect(() => { void useConnections.getState().reload().catch(e => setError(String(e))); }, [path]);
  useEffect(() => {
    setError(""); following.current = true;
    void store.open(path).catch(e => setError(String(e)));
    return () => { void useConversation.getState().flush(path).catch(() => {}); };
  }, [path, reloadToken]);
  useEffect(() => {
    if (snapshot && !connectionName && connectionsLoaded) {
      const first = firstConnectionName(entries);
      if (first) store.edit(path, draft, first);
    }
  }, [snapshot, connectionName, connectionsLoaded, entries, path]);
  useEffect(() => { if (following.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [snapshot]);
  const turns = useMemo(() => snapshot?.document.turns ?? [], [snapshot?.document.turns]);
  const siblingSqls = useMemo(() => turns.flatMap(turn => turn.runs.map(run => run.sql)), [turns]);
  const activeTurn = turns.find(turn => turn.status === "running");
  const busy = !!activeTurn;
  const pendingQuestion = useMemo(() => activeTurn ? conversationTimeline(activeTurn).find(
    entry => entry.kind === "proposal" && entry.proposalKind === "question" && entry.resolution === "pending",
  ) : undefined, [activeTurn]);
  const events = useMemo(() => turns.flatMap(turn => turn.events), [turns]);
  const contextUsage = events.findLast(event => event.type === "context_usage");
  const compacting = busy && activeTurn.events.findLast(event => event.type === "compaction")?.phase === "started";
  const send = () => { if (!busy && !snapshot?.persistenceError) { following.current = true; void store.send(path); } };
  const respond: Respond = useCallback((runId, callId, approve, answer) => window.stela.conversation.respond(path, { runId, callId, approve, answer }).catch(e => setError(String(e))), [path]);
  const reuse = useCallback((text: string) => useConversation.getState().edit(path, text, useConversation.getState().connections[path] ?? null), [path]);
  const issue = error || store.errors[path] || snapshot?.persistenceError;
  return (
    <section className="stela-conversation flex h-full min-h-0 flex-col bg-background">
      <header className="flex h-8 flex-none items-center gap-2 border-b border-border bg-muted/20 px-3.5">
        <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-[12px] font-medium text-muted-foreground"><Bot className="h-3.5 w-3.5 text-primary" />{t("conversation.title")}</span>
        {snapshot && <PythonWorkspaceStatus sessionId={snapshot.document.id} busy={busy} />}
        {contextUsage && contextUsage.contextWindow > 0 && <ContextUsageIndicator {...contextUsage} busy={busy} />}
        {compacting && <span className="flex items-center gap-1 text-[11px] text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" />{t("agent.panel.compacting")}</span>}
        <ConnectionPicker value={connectionName} onChange={name => store.edit(path, draft, name)} />
      </header>
      <div ref={scroll} onScroll={() => { const el = scroll.current!; following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100; }} className="min-h-0 flex-1 overflow-auto px-6">
        <div className={`mx-auto w-full max-w-3xl space-y-12 pt-6 pb-2.5 ${!turns.length ? "flex h-full flex-col items-center justify-center" : ""}`}>
          {!turns.length && <div className="flex max-w-sm flex-col items-center gap-3 pb-10 text-center"><AgentBlankIllustration /><h1 className="text-sm font-medium">{t("conversation.title")}</h1><p className="text-xs leading-6 text-muted-foreground">{t("conversation.empty")}</p></div>}
          {turns.map(turn => <Turn key={turn.id} turn={turn} onRespond={respond} reuse={reuse} />)}
        </div>
      </div>
      <footer className="stela-composer-region bg-background px-6">
        <div className="mx-auto max-w-3xl space-y-2">
          {issue && <div role="alert" className="flex items-center gap-2 text-xs text-destructive"><span className="flex-1">{issue}</span><button title={t("conversation.reload")} onClick={() => { setError(""); void store.open(path).catch(e => setError(String(e))); }}><RotateCcw className="h-3 w-3" /></button></div>}
          {pendingQuestion?.kind === "proposal" && <QuestionCard key={pendingQuestion.id} entry={pendingQuestion} onRespond={respond} />}
          <AiPromptInput state={editorState} connectionName={connectionName} siblingSqls={siblingSqls}
            placeholder={t("conversation.placeholder")} submitEnabled={!busy && !!snapshot && !snapshot.persistenceError}
            onChange={state => store.edit(path, agentMessagePlainText(agentComposerStateToMessage(state)), connectionName, state)}
            onSubmit={send} onOpenResource={openAgentResource}
            renderActions={tools => <AgentComposerActions leading={tools} busy={busy} canSend={!!draft.trim() && !!snapshot && !snapshot.persistenceError}
              onSend={send} onCancel={() => window.stela.conversation.cancel(path).catch(e => setError(String(e)))} />} />
        </div>
      </footer>
    </section>
  );
}
