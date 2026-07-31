import type {
  AgentEvent,
  AgentHistoryRef,
  AgentHistorySession,
  AgentHistorySummary,
  AgentProposalResponse,
  AgentRunRequest,
  AgentRunResponse,
} from "@shared/types";

export function runAgent(request: AgentRunRequest): Promise<AgentRunResponse> {
  return window.stela.agent.run(request);
}

export function listAgentHistory(): Promise<AgentHistorySummary[]> {
  return window.stela.agent.listHistory();
}

export function toAgentHistoryRef(
  { sessionId, deviceSlug }: AgentHistoryRef | AgentHistorySummary,
): AgentHistoryRef {
  return { sessionId, deviceSlug };
}

export function loadAgentHistory(ref: AgentHistoryRef): Promise<AgentHistorySession> {
  return window.stela.agent.loadHistory(toAgentHistoryRef(ref));
}

export function cancelAgent(runId: string): Promise<{ cancelled: boolean }> {
  return window.stela.agent.cancel(runId);
}

export function respondAgentProposal(
  response: AgentProposalResponse,
): Promise<{ ok: boolean }> {
  return window.stela.agent.respondProposal(response);
}

export function onAgentEvent(callback: (event: AgentEvent) => void): () => void {
  return window.stela.agent.onEvent(callback);
}
