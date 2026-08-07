import type { AgentMetricDailyPoint, AgentMetricRange } from "@shared/types";

const RANGE_DAYS: Record<AgentMetricRange, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
};

export interface AgentActivityCell {
  day: string;
  total: number;
  inRange: boolean;
}

export interface AgentActivityGrid {
  cells: AgentActivityCell[];
  startDay: string;
  endDay: string;
  maxTotal: number;
  weekCount: number;
}

function startOfLocalDay(timestamp: number): Date {
  const date = new Date(timestamp);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addLocalDays(date: Date, amount: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + amount);
}

function parseLocalDay(day: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return localDayKey(date) === day ? date : null;
}

export function localDayKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function buildAgentActivityGrid(
  range: AgentMetricRange,
  generatedAt: number,
  points: AgentMetricDailyPoint[],
): AgentActivityGrid {
  const end = startOfLocalDay(generatedAt);
  let start = addLocalDays(end, -(RANGE_DAYS[range] - 1));
  for (const point of points) {
    const pointDate = parseLocalDay(point.day);
    if (pointDate && pointDate < start) start = pointDate;
  }

  const alignedStart = addLocalDays(start, -start.getDay());
  const alignedEnd = addLocalDays(end, 6 - end.getDay());
  const totals = new Map(points.map((point) => [point.day, point.total]));
  const cells: AgentActivityCell[] = [];
  for (let cursor = alignedStart; cursor <= alignedEnd; cursor = addLocalDays(cursor, 1)) {
    const day = localDayKey(cursor);
    const inRange = cursor >= start && cursor <= end;
    cells.push({ day, total: inRange ? totals.get(day) ?? 0 : 0, inRange });
  }

  return {
    cells,
    startDay: localDayKey(start),
    endDay: localDayKey(end),
    maxTotal: Math.max(0, ...points.map((point) => point.total)),
    weekCount: cells.length / 7,
  };
}

export function agentActivityLevel(total: number, maxTotal: number): 0 | 1 | 2 | 3 | 4 {
  if (total <= 0 || maxTotal <= 0) return 0;
  return Math.min(4, Math.max(1, Math.ceil((total / maxTotal) * 4))) as 1 | 2 | 3 | 4;
}
