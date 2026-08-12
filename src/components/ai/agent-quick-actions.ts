import type { AgentEntryPoint, AgentMessageContent, AgentMessageResourceInput } from "@shared/types";

import { getRunContext } from "@/editor/runsql/run-context";
import { i18n } from "@/i18n";
import { useAgentPanel } from "@/state/agent-panel";
import { useWorkspace } from "@/state/workspace";
import { composeAgentMessage } from "@/lib/agent-message";

function relativeToVault(path: string | null | undefined): string | undefined {
  if (!path) return undefined;
  const vaultPath = useWorkspace.getState().vaultPath;
  if (!vaultPath) return path;
  const root = vaultPath.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalized = path.replace(/\\/g, "/");
  return normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : normalized;
}

function locale(): "zh" | "en" {
  return i18n.resolvedLanguage?.startsWith("zh") ? "zh" : "en";
}

function open(input: {
  entryPoint: AgentEntryPoint;
  title: string;
  message: AgentMessageContent;
  connectionName?: string | null;
  autoSend: boolean;
}): void {
  useAgentPanel.getState().openQuickTask({ ...input, locale: locale() });
}

export function openRunsqlFixTask(input: {
  sql: string;
  rewriteTargetId: string;
  errorMessage: string;
  blockId?: string | null;
  blockIndex?: number;
}): void {
  const ctx = getRunContext();
  const errorMessage = input.errorMessage.length > 18_000
    ? `${input.errorMessage.slice(0, 17_960)}\n[error truncated]`
    : input.errorMessage;
  const resource: AgentMessageResourceInput = {
    kind: "runsql",
    label: i18n.t("ai.quick.runsqlAttachment"),
    sql: input.sql,
    sourcePath: relativeToVault(ctx?.path),
    locator: { blockId: input.blockId, blockIndex: input.blockIndex, keyword: input.sql, nthInFile: 0 },
    rewriteTargetId: input.rewriteTargetId,
  };
  open({
    entryPoint: "runsql-fix",
    title: i18n.t("ai.quick.fixTitle"),
    message: composeAgentMessage(
      `${i18n.t("ai.quick.fixPrompt")}\n\n`,
      resource,
      `\n\n${i18n.t("agent.panel.sqlError")}:\n${errorMessage}`,
    ),
    connectionName: ctx?.connectionName ?? null,
    autoSend: true,
  });
}

export function openRunsqlRewriteTask(sql: string, rewriteTargetId: string, blockId?: string | null, blockIndex?: number): void {
  const ctx = getRunContext();
  open({
    entryPoint: "runsql-rewrite",
    title: i18n.t("ai.quick.rewriteTitle"),
    message: composeAgentMessage(`${i18n.t("ai.quick.rewritePrompt")}\n\n`, {
      kind: "runsql",
      label: i18n.t("ai.quick.runsqlAttachment"),
      sql,
      sourcePath: relativeToVault(ctx?.path),
      locator: { blockId, blockIndex, keyword: sql, nthInFile: 0 },
      rewriteTargetId,
    }),
    connectionName: ctx?.connectionName ?? null,
    autoSend: false,
  });
}

export function openRunsqlAskTask(sql: string, blockId?: string | null, blockIndex?: number): void {
  const ctx = getRunContext();
  open({
    entryPoint: "runsql-ask",
    title: i18n.t("ai.quick.askTitle"),
    message: composeAgentMessage(`${i18n.t("ai.quick.askPrompt")}\n\n`, {
      kind: "runsql",
      label: i18n.t("ai.quick.runsqlAttachment"),
      sql,
      sourcePath: relativeToVault(ctx?.path),
      locator: { blockId, blockIndex, keyword: sql, nthInFile: 0 },
    }),
    connectionName: ctx?.connectionName ?? null,
    autoSend: false,
  });
}

export function openSchemaExplainTask(table: string, connectionName: string | null): void {
  open({
    entryPoint: "schema-explain",
    title: i18n.t("ai.quick.schemaTitle", { table }),
    message: composeAgentMessage(`${i18n.t("ai.quick.schemaPrompt")}\n\n`, {
      kind: "table",
      label: table,
      table,
      connectionName,
    }),
    connectionName,
    autoSend: true,
  });
}
