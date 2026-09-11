import type { AgentTimelineEntry } from "@/state/agent-panel";

/** Pending decisions and terminal failures must remain visible outside execution details. */
export function replyExecutionEntries(entries: AgentTimelineEntry[]): AgentTimelineEntry[] {
  return entries.filter(entry => ["tool", "progress", "plan", "strategy"].includes(entry.kind)
    || (entry.kind === "proposal" && entry.resolution !== "pending"));
}

export function splitAgentReplies(timeline: AgentTimelineEntry[]): AgentTimelineEntry[][] {
  const replies: AgentTimelineEntry[][] = [];
  for (const entry of timeline) {
    if (entry.kind === "user" || !replies.length) replies.push([]);
    replies[replies.length - 1]!.push(entry);
  }
  return replies;
}
