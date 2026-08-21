import type { AgentTimelineEntry } from "@/state/agent-panel";

export type AgentToolTimelineEntry = Extract<AgentTimelineEntry, { kind: "tool" }>;
export type AgentProgressTimelineEntry = Extract<AgentTimelineEntry, { kind: "progress" }>;

export type AgentTimelineRenderItem =
  | { kind: "entry"; entry: AgentTimelineEntry }
  | { kind: "tools"; id: string; entries: AgentToolTimelineEntry[] }
  | { kind: "progress"; id: string; entries: AgentProgressTimelineEntry[] };

/**
 * Keep live model narration in causal order. Once a run settles, collect prior
 * model-step narration into one collapsed group without merging tool batches
 * that were separated by those steps.
 */
export function groupAgentTimeline(
  timeline: AgentTimelineEntry[],
  collapseProgress: boolean,
): AgentTimelineRenderItem[] {
  const items: AgentTimelineRenderItem[] = [];
  const progressByRun = new Map<string, AgentProgressTimelineEntry[]>();
  if (collapseProgress) {
    for (const entry of timeline) {
      if (entry.kind !== "progress") continue;
      progressByRun.set(entry.runId, [...(progressByRun.get(entry.runId) ?? []), entry]);
    }
  }
  const insertedProgressRuns = new Set<string>();
  let toolBarrier = false;

  for (const entry of timeline) {
    if (entry.kind === "proposal" && entry.proposalKind === "question" && entry.resolution === "pending") {
      continue;
    }
    if (entry.kind === "progress" && collapseProgress) {
      if (!insertedProgressRuns.has(entry.runId)) {
        items.push({ kind: "progress", id: `progress-${entry.runId}`, entries: progressByRun.get(entry.runId) ?? [] });
        insertedProgressRuns.add(entry.runId);
      }
      toolBarrier = true;
      continue;
    }
    if (entry.kind === "tool") {
      const last = items[items.length - 1];
      if (!toolBarrier && last?.kind === "tools") {
        last.entries.push(entry);
      } else {
        items.push({ kind: "tools", id: entry.id, entries: [entry] });
      }
      toolBarrier = false;
      continue;
    }
    toolBarrier = false;
    items.push({ kind: "entry", entry });
  }
  return items;
}
