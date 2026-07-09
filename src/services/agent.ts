import type { AgentEvent, AgentProposalResponse, AgentRunRequest } from "@shared/types";

export function runAgent(request: AgentRunRequest): Promise<{ runId: string }> {
  return window.stela.agent.run(request);
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
