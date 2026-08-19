import type {
  AgentCanvasRefreshRequest,
  AgentEntryPoint,
  AgentMessageContent,
} from "@shared/types";

import { composeAgentMessage } from "@/lib/agent-message";

export type AgentEmptyActionId =
  | "canvas-create"
  | "canvas-refresh"
  | "document-summary"
  | "canvas-summary"
  | "data-audit"
  | "canvas-audit"
  | "knowledge-maintenance";

export interface AgentEmptyWorkspace {
  kind: "note" | "canvas";
  path: string;
  title: string;
}

export interface AgentEmptyAction {
  id: AgentEmptyActionId;
  entryPoint: AgentEntryPoint;
  message: AgentMessageContent;
  canvasRefresh?: AgentCanvasRefreshRequest;
}

export interface AgentEmptyActionCopy {
  canvasCreatePrompt: string;
  canvasRefreshPrompt: string;
  documentSummaryPrompt: string;
  canvasSummaryPrompt: string;
  dataAuditPrompt: string;
  canvasAuditPrompt: string;
  knowledgeMaintenancePrompt: string;
}

function textMessage(text: string): AgentMessageContent {
  return {
    version: 1,
    segments: [{ kind: "text", text }],
    resources: [],
  };
}

function resourceMessage(prompt: string, workspace: AgentEmptyWorkspace): AgentMessageContent {
  const resource = workspace.kind === "note"
    ? { kind: "note" as const, label: workspace.title, path: workspace.path }
    : { kind: "canvas" as const, label: workspace.title, path: workspace.path };
  return composeAgentMessage(`${prompt}\n\n`, resource);
}

export function buildAgentEmptyActions(input: {
  workspace: AgentEmptyWorkspace | null;
  copy: AgentEmptyActionCopy;
}): AgentEmptyAction[] {
  const actions: AgentEmptyAction[] = [];
  if (input.workspace?.kind === "note") {
    actions.push(
      {
        id: "canvas-create",
        entryPoint: "chat",
        message: resourceMessage(input.copy.canvasCreatePrompt, input.workspace),
      },
      {
        id: "document-summary",
        entryPoint: "chat",
        message: resourceMessage(input.copy.documentSummaryPrompt, input.workspace),
      },
      {
        id: "data-audit",
        entryPoint: "chat",
        message: resourceMessage(input.copy.dataAuditPrompt, input.workspace),
      },
    );
  } else if (input.workspace?.kind === "canvas") {
    actions.push(
      {
        id: "canvas-refresh",
        entryPoint: "canvas-refresh",
        message: resourceMessage(input.copy.canvasRefreshPrompt, input.workspace),
        canvasRefresh: { path: input.workspace.path },
      },
      {
        id: "canvas-summary",
        entryPoint: "chat",
        message: resourceMessage(input.copy.canvasSummaryPrompt, input.workspace),
      },
      {
        id: "canvas-audit",
        entryPoint: "chat",
        message: resourceMessage(input.copy.canvasAuditPrompt, input.workspace),
      },
    );
  }

  actions.push({
    id: "knowledge-maintenance",
    entryPoint: "knowledge-maintenance",
    message: textMessage(input.copy.knowledgeMaintenancePrompt),
  });
  return actions;
}

export function formatMaintenanceRecency(timestamp: number, now: number, locale: string): string {
  const elapsed = Math.max(0, now - timestamp);
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (elapsed < 60_000) return formatter.format(0, "second");
  if (elapsed < 90 * 60_000) return formatter.format(-Math.round(elapsed / 60_000), "minute");
  if (elapsed < 36 * 60 * 60_000) return formatter.format(-Math.round(elapsed / (60 * 60_000)), "hour");
  if (elapsed < 45 * 24 * 60 * 60_000) return formatter.format(-Math.round(elapsed / (24 * 60 * 60_000)), "day");
  return formatter.format(-Math.round(elapsed / (30 * 24 * 60 * 60_000)), "month");
}
