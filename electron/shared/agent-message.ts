import type {
  AgentMessageContent,
  AgentMessageResource,
  AgentMessageResourceInput,
  AgentMessageSegment,
  AgentRunRequest,
} from "./types";

function hash(value: string): string {
  let current = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    current ^= value.charCodeAt(index);
    current = Math.imul(current, 0x01000193);
  }
  return (current >>> 0).toString(36);
}

export function agentResourceIdentity(resource: AgentMessageResourceInput | AgentMessageResource): string {
  switch (resource.kind) {
    case "table":
      return `table\n${resource.connectionName ?? ""}\n${resource.table}`;
    case "note":
    case "canvas":
      return `${resource.kind}\n${resource.path}`;
    case "runsql":
      return `runsql\n${resource.sourcePath ?? ""}\n${resource.locator?.blockId ?? ""}\n${resource.locator?.blockIndex ?? ""}\n${resource.sql}`;
    case "selection":
      return `selection\n${resource.sourcePath ?? ""}\n${resource.locator?.nthInFile ?? ""}\n${resource.text}`;
  }
}

export function agentResourceId(resource: AgentMessageResourceInput): string {
  return `resource_${resource.kind}_${hash(agentResourceIdentity(resource))}`;
}

export function withAgentResourceId(resource: AgentMessageResourceInput): AgentMessageResource {
  return { ...resource, id: agentResourceId(resource) } as AgentMessageResource;
}

export function compactAgentMessage(message: AgentMessageContent): AgentMessageContent {
  const referenced = new Set(
    message.segments.flatMap((segment) => segment.kind === "resource" ? [segment.resourceId] : []),
  );
  const segments: AgentMessageSegment[] = [];
  for (const segment of message.segments) {
    if (segment.kind === "text" && !segment.text) continue;
    const last = segments.at(-1);
    if (segment.kind === "text" && last?.kind === "text") last.text += segment.text;
    else segments.push(segment);
  }
  return {
    version: 1,
    segments,
    resources: message.resources.filter((resource) => referenced.has(resource.id)),
  };
}

export function agentMessagePlainText(message: AgentMessageContent): string {
  const resources = new Map(message.resources.map((resource) => [resource.id, resource]));
  return message.segments.map((segment) => {
    if (segment.kind === "text") return segment.text;
    const resource = resources.get(segment.resourceId);
    return resource ? `[${resource.kind}: ${resource.label}]` : "[missing resource]";
  }).join("");
}

export function legacyAgentMessage(request: Pick<
  AgentRunRequest,
  "prompt" | "mentionedTables" | "referencedNotes" | "attachments" | "canvasPath" | "connectionName"
>): AgentMessageContent {
  const resources: AgentMessageResource[] = [];
  const segments: AgentMessageSegment[] = [];
  const append = (resource: AgentMessageResourceInput) => {
    const next = withAgentResourceId(resource);
    if (!resources.some((existing) => existing.id === next.id)) resources.push(next);
    segments.push({ kind: "resource", resourceId: next.id }, { kind: "text", text: " " });
  };
  for (const table of request.mentionedTables ?? []) {
    append({ kind: "table", label: table, table, connectionName: request.connectionName });
  }
  for (const path of request.referencedNotes ?? []) {
    append({ kind: "note", label: path.split("/").pop() || path, path });
  }
  if (request.canvasPath) {
    append({ kind: "canvas", label: request.canvasPath.split("/").pop() || request.canvasPath, path: request.canvasPath });
  }
  for (const attachment of request.attachments ?? []) {
    if (attachment.kind === "runsql") {
      append({
        kind: "runsql",
        label: attachment.label,
        sql: attachment.sql,
        sourcePath: attachment.sourcePath,
        locator: attachment.locator,
        rewriteTargetId: attachment.rewriteTargetId,
      });
      if (attachment.errorMessage) {
        segments.push({ kind: "text", text: `\nExecution error:\n${attachment.errorMessage}\n` });
      }
    } else {
      append({
        kind: "selection",
        label: attachment.label,
        text: attachment.text,
        sourcePath: attachment.sourcePath,
        locator: attachment.locator,
      });
    }
  }
  segments.push({ kind: "text", text: request.prompt });
  return compactAgentMessage({ version: 1, segments, resources });
}

export function requestAgentMessage(request: AgentRunRequest): AgentMessageContent {
  return request.message ?? legacyAgentMessage(request);
}
