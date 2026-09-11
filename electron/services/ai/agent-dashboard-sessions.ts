import fs from "node:fs/promises";
import path from "node:path";
import { CONVERSATION_EXTENSION, type IConversationSnapshot } from "@shared/conversation";
import type { AgentMetricSessionRef, IAgentMetricSessionHistory, IAgentMetricSessionList, IAgentMetricSessionSummary } from "@shared/types";
import { AppError } from "@shared/errors";
import { ensureWithinVault, listDir } from "../vault-fs";
import { inspectConversation } from "../conversation";
import { listAgentHistory, loadAgentHistory } from "./agent-history";

function summary(snapshot: IConversationSnapshot): IAgentMetricSessionSummary {
  const doc = snapshot.document;
  return { ref: { conversationPath: snapshot.path, sessionId: doc.id }, sessionId: doc.id,
    title: doc.title, createdAt: doc.createdAt, updatedAt: doc.updatedAt };
}

export async function listDashboardSessions(vault: string, deviceSlug: string): Promise<IAgentMetricSessionList> {
  const result: IAgentMetricSessionList = { sessions: [], warnings: [] };
  const warn = (source: string, error: unknown) => {
    result.warnings.push(`${source}: ${error instanceof Error ? error.message : String(error)}`);
  };
  try {
    const history = await listAgentHistory(vault, deviceSlug);
    result.sessions.push(...history.filter(item => item.isLocal).map(item => ({
      ref: { sessionId: item.sessionId, deviceSlug: item.deviceSlug }, sessionId: item.sessionId,
      title: item.title, createdAt: item.createdAt, updatedAt: item.updatedAt,
    })));
  } catch (error) { warn("Agent History", error); }
  const visit = async (directory: string): Promise<void> => {
    let entries;
    try { entries = await listDir(await ensureWithinVault(vault, directory)); }
    catch (error) { warn(path.relative(vault, directory) || ".", error); return; }
    for (const entry of entries) {
      if (!entry.isDir && !entry.name.endsWith(CONVERSATION_EXTENSION)) continue;
      try {
        const stat = await fs.lstat(entry.path);
        if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) continue;
        if (entry.isDir) { await visit(entry.path); continue; }
        const snapshot = await inspectConversation(vault, entry.path);
        // Draft-only files are not sessions yet. SQL-only conversations are.
        if (snapshot.document.turns.length) result.sessions.push(summary(snapshot));
        if (snapshot.persistenceError) warn(entry.name, snapshot.persistenceError);
      } catch (error) { warn(path.relative(vault, entry.path), error); }
    }
  };
  await visit(vault);
  result.sessions.sort((a, b) => b.updatedAt - a.updatedAt || a.title.localeCompare(b.title));
  return result;
}

export async function loadDashboardSession(vault: string, deviceSlug: string, ref: AgentMetricSessionRef): Promise<IAgentMetricSessionHistory> {
  if (!("conversationPath" in ref)) return loadAgentHistory(vault, ref, deviceSlug);
  const snapshot = await inspectConversation(vault, ref.conversationPath);
  if (snapshot.document.id !== ref.sessionId) {
    throw new AppError("conversation_conflict", "Conversation identity changed. Refresh the session list.");
  }
  return {
    summary: summary(snapshot),
    runs: snapshot.document.turns.map(turn => ({
      request: { runId: turn.id, sessionId: snapshot.document.id, entryPoint: "chat", prompt: turn.input,
        message: turn.message, connectionName: turn.connectionName },
      startedAt: turn.startedAt,
      // Chat v1 has no turn completion timestamp. Lifecycle comes from status.
      finishedAt: null,
      events: turn.events,
      proposalResponses: turn.responses,
      conversation: { status: turn.status, error: turn.error, runs: turn.runs },
    })),
  };
}
