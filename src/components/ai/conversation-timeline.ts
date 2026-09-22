import { applyEvent, type AgentTimelineEntry } from "@/state/agent-panel";
import type { ConversationTurn } from "@shared/conversation";

/** Project durable events through the same reducer used by the Agent panel. */
export function conversationTimeline(turn: ConversationTurn): AgentTimelineEntry[] {
  return turn.events.reduce<AgentTimelineEntry[]>(applyEvent, []).map((value, index) => {
    const entry = { ...value, id: `${turn.id}-${index}` };
    if (entry.kind !== "proposal") return entry;
    const response = turn.responses.find(r => r.callId === entry.callId);
    return response
      ? { ...entry, resolution: response.approve ? "approved" : "rejected", answer: response.answer }
      : turn.status !== "running" ? { ...entry, resolution: "expired" } : entry;
  });
}

/** Attach recorded tables to their tool call, keeping failed direct SQL before repair. */
export function conversationResults(turn: ConversationTurn, timeline: AgentTimelineEntry[]) {
  const remaining = [...turn.runs];
  const byEntry = new Map<string, ConversationTurn["runs"]>();
  for (const entry of timeline) {
    if (entry.kind !== "tool") continue;
    const args = entry.args as { sql?: string; query?: string } | null;
    const exact = remaining.findIndex(run => entry.result?.summary.includes(run.runId));
    const index = exact >= 0 ? exact : remaining.findIndex(run =>
      run.blockId !== turn.id && (args?.sql === run.sql || args?.query === run.sql),
    );
    if (index >= 0) byEntry.set(entry.id, remaining.splice(index, 1));
  }
  return { before: remaining.filter(run => run.blockId === turn.id), after: remaining.filter(run => run.blockId !== turn.id), byEntry };
}
