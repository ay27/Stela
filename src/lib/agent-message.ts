import {
  agentResourceIdentity,
  compactAgentMessage,
  withAgentResourceId,
} from "@shared/agent-message";
import type {
  AgentMessageContent,
  AgentMessageResource,
  AgentMessageResourceInput,
} from "@shared/types";

export function upsertAgentResource(
  resources: AgentMessageResource[],
  input: AgentMessageResourceInput | AgentMessageResource,
): { resource: AgentMessageResource; resources: AgentMessageResource[] } {
  const identity = agentResourceIdentity(input);
  const existing = resources.find((candidate) => agentResourceIdentity(candidate) === identity);
  if (existing) return { resource: existing, resources };
  const resource = "id" in input ? input : withAgentResourceId(input);
  return { resource, resources: [...resources, resource] };
}

export function composeAgentMessage(
  before: string,
  resourceInput: AgentMessageResourceInput | AgentMessageResource,
  after = "",
): AgentMessageContent {
  const { resource, resources } = upsertAgentResource([], resourceInput);
  return compactAgentMessage({
    version: 1,
    segments: [
      ...(before ? [{ kind: "text" as const, text: before }] : []),
      { kind: "resource", resourceId: resource.id },
      ...(after ? [{ kind: "text" as const, text: after }] : []),
    ],
    resources,
  });
}

export function isAgentMessageEmpty(message: AgentMessageContent): boolean {
  return !message.segments.some((segment) =>
    segment.kind === "resource" || segment.text.trim().length > 0,
  );
}
