import {
  createMentionMarkup,
  parseMarkup,
  plainIndexToMarkupIndex,
  type MentionItem,
  type TriggerConfig,
} from "@skyastrall/mentions-core";

import {
  agentResourceIdentity,
  compactAgentMessage,
} from "@shared/agent-message";
import type {
  AgentMessageContent,
  AgentMessageResource,
  AgentMessageResourceInput,
  AgentMessageSegment,
} from "@shared/types";

export const AGENT_RESOURCE_TRIGGER = "@";
export const AGENT_RESOURCE_MARKUP = "@[__display__](__id__)";
export const AGENT_RESOURCE_TRIGGER_CONFIG: TriggerConfig = {
  char: AGENT_RESOURCE_TRIGGER,
  markup: AGENT_RESOURCE_MARKUP,
  data: [],
  minChars: 0,
  debounce: 40,
  maxSuggestions: 24,
  allowSpaceInQuery: true,
  color: "hsl(var(--primary) / 0.14)",
};

const TYPE_LABEL: Record<AgentMessageResource["kind"], string> = {
  table: "Table",
  note: "Doc",
  canvas: "Canvas",
  runsql: "RunSQL",
  selection: "Selection",
};

export function agentResourceDisplay(resource: AgentMessageResource): string {
  return `${TYPE_LABEL[resource.kind]} · ${resource.label}`;
}

export function agentResourceMentionItem(resource: AgentMessageResource): MentionItem {
  return { id: resource.id, label: agentResourceDisplay(resource) };
}

export function emptyAgentMessage(): AgentMessageContent {
  return { version: 1, segments: [], resources: [] };
}

export function messageToMarkup(message: AgentMessageContent): string {
  const resources = new Map(message.resources.map((resource) => [resource.id, resource]));
  return message.segments.map((segment) => {
    if (segment.kind === "text") return segment.text;
    const resource = resources.get(segment.resourceId);
    return resource
      ? createMentionMarkup(agentResourceMentionItem(resource), AGENT_RESOURCE_TRIGGER_CONFIG)
      : "[missing resource]";
  }).join("");
}

export function agentMessageVisibleLength(message: AgentMessageContent): number {
  return parseMarkup(messageToMarkup(message), [AGENT_RESOURCE_TRIGGER_CONFIG])
    .reduce((length, segment) => length + segment.text.length, 0);
}

export function markupToMessage(
  markup: string,
  availableResources: Iterable<AgentMessageResource>,
): AgentMessageContent {
  const resources = new Map(Array.from(availableResources, (resource) => [resource.id, resource]));
  const segments: AgentMessageSegment[] = parseMarkup(markup, [AGENT_RESOURCE_TRIGGER_CONFIG]).map((segment) => {
    if (segment.type === "text") return { kind: "text" as const, text: segment.text };
    return resources.has(segment.id)
      ? { kind: "resource" as const, resourceId: segment.id }
      : { kind: "text" as const, text: segment.text };
  });
  return compactAgentMessage({ version: 1, segments, resources: [...resources.values()] });
}

export function upsertAgentResource(
  resources: AgentMessageResource[],
  input: AgentMessageResourceInput | AgentMessageResource,
): { resource: AgentMessageResource; resources: AgentMessageResource[] } {
  const identity = agentResourceIdentity(input);
  const existing = resources.find((candidate) => agentResourceIdentity(candidate) === identity);
  if (existing) return { resource: existing, resources };
  const resource = "id" in input ? input : {
    ...input,
    id: `resource_${input.kind}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
  } as AgentMessageResource;
  return { resource, resources: [...resources, resource] };
}

export function insertAgentResource(
  message: AgentMessageContent,
  resourceInput: AgentMessageResourceInput | AgentMessageResource,
  plainOffset: number,
): { message: AgentMessageContent; cursorOffset: number } {
  const upserted = upsertAgentResource(message.resources, resourceInput);
  const markup = messageToMarkup(message);
  const parsed = parseMarkup(markup, [AGENT_RESOURCE_TRIGGER_CONFIG]);
  const visibleLength = parsed.reduce((length, segment) => length + segment.text.length, 0);
  const safeOffset = Math.max(0, Math.min(plainOffset, visibleLength));
  const markupOffset = plainIndexToMarkupIndex(parsed, safeOffset);
  const before = markup.slice(0, markupOffset);
  const after = markup.slice(markupOffset);
  const leading = before.length > 0 && !/\s$/.test(before) ? " " : "";
  const trailing = after.length > 0 && !/^\s/.test(after) ? " " : "";
  const token = createMentionMarkup(agentResourceMentionItem(upserted.resource), AGENT_RESOURCE_TRIGGER_CONFIG);
  const nextMarkup = `${before}${leading}${token}${trailing}${after}`;
  return {
    message: markupToMessage(nextMarkup, upserted.resources),
    cursorOffset: safeOffset + leading.length + AGENT_RESOURCE_TRIGGER.length +
      agentResourceDisplay(upserted.resource).length + trailing.length,
  };
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
