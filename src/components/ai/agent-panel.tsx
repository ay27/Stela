import { replyExecutionEntries, splitAgentReplies } from "./reply-layout";
import "./assistant-output.css";
import { AssistantReplyDivider } from "./assistant-reply-divider";
import { readAnalysisSnapshot } from "@shared/analysis-contract";
import { AnalysisEvidence } from "./analysis-evidence";
import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  BarChart3,
  Brain,
  CheckCircle2,
  ChevronRight,
  ChevronDown,
  Circle,
  ClipboardCheck,
  FileText,
  HelpCircle,
  History,
  Loader2,
  MinusCircle,
  RefreshCw,
  Send,
  Sparkles,
  ShieldAlert,
  StopCircle,
  XCircle,
} from "lucide-react";
import type {
  AgentMessageContent,
  AgentMessageResource,
  AgentPlanSnapshot,
  AiProviderStatus,
} from "@shared/types";

import { ProposalLineDiff } from "./proposal-diff";
import { useT } from "@/i18n/use-t";
import { cn } from "@/lib/utils";

import {
  resolveCanvasArtifactPath,
  type AgentTimelineEntry,
} from "@/state/agent-panel";
import { useLayout } from "@/state/layout";
import { useWorkspace } from "@/state/workspace";
import { useSettings } from "@/state/settings";

import { renderMarkdown } from "./markdown-renderer";
import { agentResourceDisplay } from "@/lib/agent-composer";
import {
  type AgentEmptyAction,
  type AgentEmptyActionId,
} from "./agent-empty-state";
import {
  type AgentProgressTimelineEntry,
} from "./agent-timeline";


function EmptyActionIcon({ id }: { id: AgentEmptyActionId }) {
  switch (id) {
    case "canvas-create":
      return <BarChart3 className="h-3.5 w-3.5" />;
    case "canvas-refresh":
      return <RefreshCw className="h-3.5 w-3.5" />;
    case "document-summary":
    case "canvas-summary":
      return <FileText className="h-3.5 w-3.5" />;
    case "data-audit":
    case "canvas-audit":
      return <ClipboardCheck className="h-3.5 w-3.5" />;
    case "knowledge-maintenance":
      return <Brain className="h-3.5 w-3.5" />;
  }
}

export function AgentBlankIllustration() {
  return (
    <svg
      viewBox="0 0 64 48"
      className="h-12 w-16 text-muted-foreground/30"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <rect x="13" y="8" width="34" height="32" rx="4" />
      <path d="M20 17h20M20 23h14M20 29h17" strokeLinecap="round" />
      <path d="m48 27 1.5 3.5L53 32l-3.5 1.5L48 37l-1.5-3.5L43 32l3.5-1.5L48 27Z" />
    </svg>
  );
}

export function AgentPanelEmptyState({
  actions,
  knowledgeMeta,
  onRun,
}: {
  actions: AgentEmptyAction[];
  knowledgeMeta: string;
  onRun: (action: AgentEmptyAction) => void;
}) {
  const t = useT();
  const labels: Record<AgentEmptyActionId, string> = {
    "canvas-create": t("agent.panel.emptyActions.canvasCreate.title"),
    "canvas-refresh": t("agent.panel.emptyActions.canvasRefresh.title"),
    "document-summary": t("agent.panel.emptyActions.documentSummary.title"),
    "canvas-summary": t("agent.panel.emptyActions.canvasSummary.title"),
    "data-audit": t("agent.panel.emptyActions.dataAudit.title"),
    "canvas-audit": t("agent.panel.emptyActions.canvasAudit.title"),
    "knowledge-maintenance": t("agent.panel.emptyActions.knowledgeMaintenance.title"),
  };

  return (
    <div className="flex max-w-[280px] flex-col items-center py-6 text-center">
      <AgentBlankIllustration />
      <p className="mt-2 text-[12px] leading-5 text-muted-foreground">
        {t("agent.panel.emptyActions.hint")}
      </p>
      <div className="mt-3 flex w-full flex-col items-start gap-2 text-left">
        {actions.map((action) => {
          return (
            <button
              key={action.id}
              type="button"
              onClick={() => onRun(action)}
              className="inline-flex w-full items-center justify-start gap-1.5 text-left text-[12px] text-primary/80 transition-colors hover:text-primary"
            >
              <span className="flex-none opacity-80">
                <EmptyActionIcon id={action.id} />
              </span>
              <span className="underline-offset-2 hover:underline">{labels[action.id]}</span>
              {action.id === "knowledge-maintenance" ? (
                <span className="text-[10px] text-muted-foreground/70">· {knowledgeMeta}</span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function TimelineItem({
  entry,
  onRespond,
}: {
  entry: AgentTimelineEntry;
  onRespond: (runId: string, callId: string, approve: boolean, answer?: string) => Promise<void>;
}) {
  const t = useT();
  switch (entry.kind) {
    case "user":
      return (
        <div className="stela-reply-boundary">
        <div className="flex justify-end">
          <div className="stela-user-message-bubble max-w-[80%] rounded-lg px-3 py-2 text-sm text-foreground">
            <AgentUserMessage message={entry.message} />
          </div>
        </div>
        <AssistantReplyDivider />
        </div>
      );
    case "final":
      return (
        <div className="stela-assistant-output relative">
          <AssistantMessage content={entry.content} />
          {entry.maintenance ? <SkillMaintenanceIndicator maintenance={entry.maintenance} /> : null}
        </div>
      );
    case "progress":
      return <ProcessNarrationBubble entry={entry} />;
    case "error":
      return (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          {entry.message}
        </div>
      );
    case "cancelled":
      return <div className="text-xs italic text-muted-foreground">{t("agent.panel.cancelled")}</div>;
    case "interrupted":
      return (
        <div className="flex items-center gap-1.5 text-xs italic text-muted-foreground">
          <History className="h-3 w-3" />
          {t("agent.panel.interrupted")}
        </div>
      );
    case "canvas":
      return <button type="button" onClick={() => useWorkspace.getState().openFile(resolveCanvasArtifactPath(entry.path))} className="w-full rounded-lg border border-primary/30 bg-primary/5 p-3 text-left text-xs hover:bg-primary/10"><div className="font-medium text-foreground">{entry.title}</div><div className="mt-1 text-muted-foreground">{t(entry.action === "created" ? "agent.panel.canvasCreated" : "agent.panel.canvasUpdated")} · {t("agent.panel.openCanvas")}</div></button>;
    case "plan":
      return <ExecutionPlanCard plan={entry.plan} />;
    case "strategy":
      return <StrategyReviewCard entry={entry} />;
    case "tool":
      return <ToolChip entry={entry} />;
    case "proposal":
      return <ProposalCard entry={entry} onRespond={onRespond} />;
  }
}

function StrategyReviewCard({
  entry,
}: {
  entry: Extract<AgentTimelineEntry, { kind: "strategy" }>;
}) {
  const t = useT();
  const advice = entry.checkpoint?.advice;
  const title = entry.status === "working"
    ? t("agent.panel.strategyReviewWorkingTitle")
    : entry.status === "failed"
      ? t("agent.panel.strategyReviewFailedTitle")
      : t("agent.panel.strategyReviewCompletedTitle");
  return (
    <details className="group rounded-lg border border-violet-500/25 bg-violet-500/5 text-xs">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 font-medium text-foreground [&::-webkit-details-marker]:hidden">
        {entry.status === "working"
          ? <Loader2 className="h-3.5 w-3.5 animate-spin text-violet-500" />
          : <Sparkles className="h-3.5 w-3.5 text-violet-500" />}
        <span className="flex-1">{title}</span>
        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground transition-transform group-open:rotate-90" />
      </summary>
      <div className="border-t border-violet-500/15 px-3 py-2.5">
        {entry.status === "working" ? (
          <div className="text-muted-foreground">{t("agent.panel.strategyReviewWorking")}</div>
        ) : entry.status === "failed" ? (
          <div className="text-muted-foreground">{entry.message ?? t("agent.panel.strategyReviewFailed")}</div>
        ) : advice ? (
          <div className="space-y-1.5 text-muted-foreground">
            <div>{advice.diagnosis}</div>
            <ol className="list-decimal space-y-1 pl-4">
              {advice.nextActions.map((action, index) => <li key={`${index}-${action}`}>{action}</li>)}
            </ol>
            <div><span className="font-medium text-foreground">{t("agent.panel.strategyReviewAvoid")}:</span> {advice.avoid}</div>
          </div>
        ) : null}
      </div>
    </details>
  );
}

function ProcessNarrationBubble({ entry }: { entry: AgentProgressTimelineEntry }) {
  const t = useT();
  return (
    <div className="stela-assistant-output py-2 text-sm">
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
        {entry.phase === "streaming"
          ? <Loader2 className="h-3 w-3 animate-spin text-primary" />
          : <Sparkles className="h-3 w-3 text-primary" />}
        {t("agent.panel.processNarration")}
      </div>
      <AssistantMessage content={entry.content} />
    </div>
  );
}

export function openAgentResource(resource: AgentMessageResource): void {
  if (resource.kind === "table") {
    useLayout.getState().revealSchemaTable(resource.connectionName ?? null, resource.table);
    return;
  }
  if (resource.kind === "note" || resource.kind === "canvas") {
    useWorkspace.getState().openFile(resolveCanvasArtifactPath(resource.path));
    return;
  }
  if (!resource.sourcePath) return;
  const keyword = resource.locator?.keyword ?? (resource.kind === "runsql" ? resource.sql : resource.text);
  useWorkspace.getState().openFile(resolveCanvasArtifactPath(resource.sourcePath), {
    ...(resource.kind === "runsql" ? {
      runsqlBlockId: resource.locator?.blockId,
      runsqlBlockIndex: resource.locator?.blockIndex,
      runsqlSql: resource.sql,
    } : {}),
    ...(keyword ? { keyword, nthInFile: resource.locator?.nthInFile ?? 0 } : {}),
    ...(resource.locator?.line ? {
      scrollToLine: resource.locator.line,
      scrollToColumn: resource.locator.column,
    } : {}),
  });
}

function AgentResourcePill({ resource }: { resource: AgentMessageResource }) {
  return (
    <button
      type="button"
      onClick={() => openAgentResource(resource)}
      title={resource.label}
      className={`stela-agent-resource-pill stela-agent-resource-pill--${resource.kind}`}
    >
      {agentResourceDisplay(resource)}
    </button>
  );
}

export function AgentUserMessage({ message }: { message: AgentMessageContent }) {
  const resources = new Map(message.resources.map((resource) => [resource.id, resource]));
  return (
    <div className="whitespace-pre-wrap break-words">
      {message.segments.map((segment, index) => {
        if (segment.kind === "text") return <span key={`text-${index}`}>{segment.text}</span>;
        const resource = resources.get(segment.resourceId);
        return resource ? <AgentResourcePill key={`resource-${index}`} resource={resource} /> : null;
      })}
    </div>
  );
}

function SkillMaintenanceIndicator({
  maintenance,
}: {
  maintenance: NonNullable<Extract<AgentTimelineEntry, { kind: "final" }>["maintenance"]>;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const working = maintenance.status === "working";
  const updated = maintenance.status === "updated";
  const failed = maintenance.status === "error";
  const timedOut = maintenance.status === "timeout";
  const needsAttention = failed || timedOut;
  const names = maintenance.actions.map((action) => action.name).join("、");
  const detail = working
    ? t("agent.panel.skillWorking")
    : (failed || timedOut) && maintenance.actions.length > 0 ? t("agent.panel.skillPartiallySaved")
    : failed ? t("agent.panel.skillFailed")
    : timedOut ? t(maintenance.actions.length > 0 ? "agent.panel.skillPartiallySaved" : maintenance.outcome === "turn_limit" ? "agent.panel.skillTurnLimit" : "agent.panel.skillTimedOut")
    : maintenance.status === "cancelled" ? t("agent.panel.skillCancelled")
    : maintenance.status === "skipped" ? t("agent.panel.skillSkipped")
    : maintenance.status === "unknown" ? t("agent.panel.skillUnknown")
    : maintenance.outcome === "candidate_not_published" ? t("agent.panel.skillCandidate")
    : updated
      ? t("agent.panel.skillUpdated", { names })
      : t("agent.panel.skillAllMaintained");
  return (
    <div
      className={needsAttention ? "stela-maintenance-warning relative mt-3 border-t border-border pt-2" : "absolute bottom-1.5 right-2"}
      role={needsAttention ? "status" : undefined}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setExpanded(false);
      }}
    >
      <button
        type="button"
        aria-label={detail}
        aria-expanded={expanded}
        title={detail}
        onClick={() => setExpanded((value) => !value)}
        className={cn(
          needsAttention ? "flex items-center gap-1.5 text-left text-xs" : "flex h-4 w-4 items-center justify-center rounded-full transition-colors",
          failed ? "text-destructive" : timedOut ? "text-muted-foreground" : working
            ? "text-muted-foreground"
            : updated
              ? "bg-primary/10 text-primary hover:bg-primary/20"
              : "text-muted-foreground/60 hover:bg-muted hover:text-muted-foreground",
        )}
      >
        {needsAttention ? <ShieldAlert className="h-3.5 w-3.5 shrink-0" /> : working ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <Brain className="h-3 w-3" />
        )}
        {needsAttention ? detail : null}
      </button>
      {expanded ? (
        <div className={cn("rounded-md border border-border bg-popover p-2 text-[11px] text-popover-foreground shadow-md",
          needsAttention ? "mt-2" : "absolute bottom-6 right-0 z-10 w-64")}>
          <div className="font-medium">{t("agent.panel.skillMaintenance")}</div>
          <p className="mt-1 text-muted-foreground">{detail}</p>
          {maintenance.summary ? <p className="mt-1 whitespace-pre-wrap break-words">{maintenance.summary}</p> : null}
          {maintenance.diagnostic ? <div className="mt-2 space-y-1 border-t border-border pt-2">
            <p>{t("agent.panel.skillDiagnosticHelp")}</p>
            <pre className="whitespace-pre-wrap break-all font-mono">{maintenance.diagnostic.stage}{"\n"}{maintenance.diagnostic.message}</pre>
            <p className="break-all font-mono">{maintenance.diagnostic.metricRunId}</p>
          </div> : null}
          {maintenance.actions.length > 0 ? (
            <div className="mt-2 space-y-1 border-t border-border pt-2">
              {maintenance.actions.map((action) => (
                <div key={`${action.action}-${action.path}`}>
                  {action.action === "saved" ? t("agent.panel.skillSaved") : t("agent.panel.skillArchived")} · {action.name}
                  <span className="text-muted-foreground"> — {action.reason}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function AssistantMessage({ content }: { content: string }) {
  if (!content.trim()) return null;
  return <div className="stela-ai-markdown text-sm leading-6">{renderMarkdown(content)}</div>;
}

function PlanStepIcon({ status }: { status: AgentPlanSnapshot["steps"][number]["status"] }) {
  switch (status) {
    case "completed":
      return <CheckCircle2 className="h-3.5 w-3.5 flex-none text-primary" />;
    case "running":
      return <Loader2 className="h-3.5 w-3.5 flex-none animate-spin text-primary" />;
    case "blocked":
      return <XCircle className="h-3.5 w-3.5 flex-none text-destructive" />;
    case "skipped":
      return <MinusCircle className="h-3.5 w-3.5 flex-none text-muted-foreground" />;
    default:
      return <Circle className="h-3.5 w-3.5 flex-none text-muted-foreground/50" />;
  }
}

function ExecutionPlanCard({ plan }: { plan: AgentPlanSnapshot }) {
  const t = useT();
  const [expanded, setExpanded] = useState(true);
  const completed = plan.steps.filter((step) => ["completed", "skipped"].includes(step.status)).length;
  const current = plan.steps.find((step) => step.status === "running" || step.status === "blocked");
  return (
    <div className="rounded-lg border border-primary/20 bg-primary/5 text-xs">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center justify-between gap-2 px-2.5 py-2 text-left font-medium"
      >
        <span>{t("agent.panel.planProgress", { completed, total: plan.steps.length })}</span>
        <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
          <span className="truncate">
            {current?.status === "blocked" ? t("agent.panel.blocked") : current?.title}
          </span>
          <ChevronDown className={cn("h-3 w-3 flex-none transition-transform", expanded && "rotate-180")} />
        </span>
      </button>
      {expanded ? (
        <ol className="space-y-1.5 border-t border-primary/10 px-2.5 py-2">
          {plan.deliveries?.map((item, index) => <li key={`delivery-${index}`} className="stela-plan-delivery text-muted-foreground">
            {t(item.receipt ? "agent.panel.deliverySaved" : "agent.panel.deliveryMissing", { kind: item.kind, path: item.receipt?.path ?? item.path ?? "" })}
          </li>)}
          {plan.steps.map((step) => (
            <li key={step.id} className="flex items-start gap-2">
              <span className="mt-px"><PlanStepIcon status={step.status} /></span>
              <span
                className={cn(
                  "min-w-0",
                  step.status === "pending" && "text-muted-foreground",
                  step.status === "skipped" && "text-muted-foreground line-through",
                  step.status === "blocked" && "text-destructive",
                )}
              >
                {step.title}
                {step.evidence ? (
                  <span className="block text-[11px] text-muted-foreground">{step.evidence}</span>
                ) : null}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

function ToolChip({ entry }: { entry: Extract<AgentTimelineEntry, { kind: "tool" }> }) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const pending = !entry.result;
  const failed = entry.result && !entry.result.ok;
  return (
    <div className="py-1 text-xs">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 py-1.5 text-left"
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
        <div className="space-y-2 py-2 font-mono text-[11px] text-muted-foreground">
          <div>
            <div className="mb-1 text-foreground/70">{t("agent.panel.arguments")}</div>
            <pre className="overflow-auto whitespace-pre-wrap">{JSON.stringify(entry.args, null, 2)}</pre>
          </div>
          {entry.result ? (
            <div>
              <div className="mb-1 text-foreground/70">{t("agent.panel.result")}</div>
              <AnalysisEvidence snapshot={readAnalysisSnapshot(entry.result.summary)} />
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap">{entry.result.summary}</pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * `question` kind：agent 停下来问一句，用户点候选或自由输入。
 * 复用 proposal 的阻塞通道（见 ADR-0027），所以这里只换外观与提交语义。
 */
export function QuestionCard({
  entry,
  onRespond,
}: {
  entry: Extract<AgentTimelineEntry, { kind: "proposal" }>;
  onRespond: (runId: string, callId: string, approve: boolean, answer?: string) => Promise<void>;
}) {
  const t = useT();
  const [draft, setDraft] = useState("");
  const resolved = entry.resolution !== "pending";
  const answer = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    void onRespond(entry.runId, entry.callId, true, trimmed);
  };
  return (
    <div
      className={cn(
        "stela-agent-question rounded-lg border p-3 text-sm",
        resolved ? "border-border bg-muted/30" : "border-sky-400/50 bg-sky-400/10",
      )}
    >
      <div className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-sky-600">
        <HelpCircle className="h-3.5 w-3.5" />
        {t("agent.panel.proposal.question")}
      </div>
      <div className="mb-2 whitespace-pre-wrap text-foreground">
        {entry.payload.question ?? entry.payload.description}
      </div>
      {entry.payload.question && entry.payload.description !== entry.payload.question ? (
        <div className="mb-2 text-[11px] text-muted-foreground">{entry.payload.description}</div>
      ) : null}
      {resolved ? (
        <div className="text-xs text-muted-foreground">
          {entry.resolution === "expired"
            ? t("agent.panel.proposal.expired")
            : entry.answer
            ? t("agent.panel.proposal.answered", { answer: entry.answer })
            : t("agent.panel.proposal.rejected")}
        </div>
      ) : (
        <>
          {entry.payload.options && entry.payload.options.length > 0 ? (
            <div className="mb-2 flex flex-wrap gap-2">
              {entry.payload.options.map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => answer(option)}
                  className="rounded-md border border-sky-400/50 bg-background px-2.5 py-1 text-xs hover:bg-accent"
                >
                  {option}
                </button>
              ))}
            </div>
          ) : null}
          <div className="flex gap-2">
            <input
              type="text"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  answer(draft);
                }
              }}
              placeholder={t("agent.panel.proposal.answerPlaceholder")}
              className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-xs"
            />
            <button
              type="button"
              onClick={() => answer(draft)}
              disabled={!draft.trim()}
              className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50"
            >
              {t("agent.panel.proposal.answerSend")}
            </button>
            <button
              type="button"
              onClick={() => void onRespond(entry.runId, entry.callId, false)}
              className="rounded-md border border-border px-3 py-1 text-xs hover:bg-accent"
            >
              {t("agent.panel.proposal.answerSkip")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function ProposalCard({
  entry,
  onRespond,
}: {
  entry: Extract<AgentTimelineEntry, { kind: "proposal" }>;
  onRespond: (runId: string, callId: string, approve: boolean, answer?: string) => Promise<void>;
}) {
  const t = useT();
  const resolved = entry.resolution !== "pending";
  if (entry.proposalKind === "question") {
    return <QuestionCard entry={entry} onRespond={onRespond} />;
  }
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
      {entry.payload.oldContent != null || entry.payload.newContent != null ? (
        <ProposalLineDiff
          oldContent={entry.payload.oldContent ?? ""}
          newContent={entry.payload.newContent ?? ""}
        />
      ) : null}
      {resolved ? (
        <div className="text-xs text-muted-foreground">
          {entry.resolution === "expired"
            ? t("agent.panel.proposal.expired")
            : entry.resolution === "approved"
            ? entry.approvalMode === "automatic"
              ? t("agent.panel.proposal.autoApplied")
              : t("agent.panel.proposal.approved")
            : t("agent.panel.proposal.rejected")}
        </div>
      ) : entry.approvalMode === "automatic" ? (
        <div className="text-xs text-muted-foreground">
          {t("agent.panel.proposal.autoApplying")}
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

/** One disclosure per reply, independent of the number of tool/narration events. */
export const AgentTimelineContent = memo(function AgentTimelineContent({ timeline, busy, onRespond, afterEntry, executionContent }: {
  timeline: AgentTimelineEntry[];
  busy: boolean;
  onRespond: (runId: string, callId: string, approve: boolean, answer?: string) => Promise<void>;
  afterEntry?: (entry: AgentTimelineEntry) => ReactNode;
  executionContent?: ReactNode;
}) {
  const replies = useMemo(() => splitAgentReplies(timeline), [timeline]);
  return <>{replies.map((entries, index) => <ReplyContent key={entries[0]?.id ?? index}
    entries={entries} busy={busy && index === replies.length - 1} onRespond={onRespond}
    afterEntry={afterEntry} executionContent={index === 0 ? executionContent : undefined} />)}
    {!replies.length && executionContent}
  </>;
});

export function AgentThinkingStatus() {
  const t = useT();
  return <div role="status" className="stela-agent-thinking flex items-center gap-2 py-1 text-[11px] leading-4 text-muted-foreground">
    <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
    {t("agent.panel.thinking")}
  </div>;
}

function ReplyContent({ entries, busy, onRespond, afterEntry, executionContent }: {
  entries: AgentTimelineEntry[]; busy: boolean;
  onRespond: (runId: string, callId: string, approve: boolean, answer?: string) => Promise<void>;
  afterEntry?: (entry: AgentTimelineEntry) => ReactNode; executionContent?: ReactNode;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  useEffect(() => { if (!busy) setExpanded(false); }, [busy]);
  const process = replyExecutionEntries(entries);
  const visible = entries.filter(entry => entry.kind !== "user" && !process.includes(entry));
  const tools = process.filter(entry => entry.kind === "tool");
  const queries = tools.filter(entry => entry.kind === "tool" && ["run_query", "execute_sql", "run_sql"].includes(entry.name)).length;
  const latest = [...process].reverse().find(entry => entry.kind === "progress" || (entry.kind === "tool" && !entry.result));
  const current = latest?.kind === "progress" ? latest.content : latest?.kind === "tool" ? latest.name : t("agent.panel.thinking");
  return <section className="stela-agent-reply">
    {entries.filter(entry => entry.kind === "user").map(entry => <TimelineItem key={entry.id} entry={entry} onRespond={onRespond} />)}
    <div className="stela-reply-body">
    {(process.length > 0 || executionContent) && <div className="stela-reply-execution text-xs text-muted-foreground">
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)} className="flex w-full min-w-0 items-center gap-2 py-1 text-left hover:text-foreground">
        {busy ? <Loader2 className="h-3 w-3 shrink-0 animate-spin" /> : <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", expanded && "rotate-90")} />}
        <span className="truncate">{busy ? current : queries ? t("agent.reply.queries", { count: queries }) : t("agent.reply.execution")}</span>
      </button>
      {expanded && <div className="space-y-2 border-l border-border pl-3">
        {executionContent}
        {process.map(entry => <div key={entry.id}><TimelineItem entry={entry} onRespond={onRespond} />{afterEntry?.(entry)}</div>)}
      </div>}
    </div>}
    {visible.map(entry => <div key={entry.id}><TimelineItem entry={entry} onRespond={onRespond} />{afterEntry?.(entry)}</div>)}
    {busy && !process.length && !executionContent && !visible.some(entry => entry.kind === "proposal" && entry.resolution === "pending") && <AgentThinkingStatus />}
    </div>
  </section>;
}

export function AgentComposerActions({ busy, canSend, onSend, onCancel, leading }: {
  leading?: ReactNode;
  busy: boolean; canSend: boolean; onSend: () => void; onCancel: () => void | Promise<void>;
}) {
  const t = useT();
  const aiSettings = useSettings((s) => s.settings.ai);
  const patchSettings = useSettings((s) => s.patch);
  const [providerStatus, setProviderStatus] = useState<AiProviderStatus | null>(null);
  useEffect(() => {
    void window.stela.ai.getStatus().then(setProviderStatus).catch(() => {
      setProviderStatus(null);
    });
  }, [aiSettings.activeProfileId, aiSettings.profiles]);
  return (
        <div className="flex w-full items-center justify-between gap-1.5">
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            {leading}
            {aiSettings.profiles.length > 0 ? (
              <select
                value={aiSettings.activeProfileId}
                disabled={false}
                title={t("agent.panel.provider")}
                onChange={(e) => {
                  const id = e.target.value;
                  void patchSettings({ ai: { activeProfileId: id } });
                }}
                className="w-full max-w-[240px] truncate rounded-md border-0 bg-transparent px-1.5 py-1.5 text-[11px] text-foreground disabled:opacity-40"
              >
                {aiSettings.profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                    {profile.model ? ` · ${profile.model}` : ""}
                    {` · ${
                      profile.id === providerStatus?.activeProfileId
                        ? (providerStatus.requestedReasoningEffort ?? "medium") ===
                            (providerStatus.effectiveReasoningEffort ?? "medium")
                          ? providerStatus.effectiveReasoningEffort ?? "medium"
                          : `${providerStatus.requestedReasoningEffort ?? "medium"}→${providerStatus.effectiveReasoningEffort ?? "medium"}`
                        : profile.reasoningEffort ?? "medium"
                    }`}
                  </option>
                ))}
              </select>
            ) : null}
          </div>
          {busy ? (
            <button
              type="button"
              onClick={() => void onCancel()}
              title={t("agent.panel.cancel")}
              className="inline-flex items-center gap-1 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-[11px] font-medium text-destructive hover:bg-destructive/20"
            >
              <StopCircle className="h-3.5 w-3.5" />
            </button>
          ) : (
            <button
              type="button"
              onClick={onSend}
              disabled={!canSend}
              title={`${t("agent.panel.send")} (⌘/Ctrl+Enter)`}
              className="inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1.5 text-[11px] font-medium text-primary-foreground disabled:opacity-40"
            >
              <Send className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
  );
}
