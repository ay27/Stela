import type { DetailMeta } from "@/core/types";

import { matchDetail, parseDetail } from "./detail-meta";

export interface RunsqlFenceInfo {
  index: number;
  codeStart: number;
  codeEnd: number;
  sql: string;
  detailStart: number | null;
  detailEnd: number | null;
  detail: DetailMeta | null;
  detailRaw: string | null;
  blockId: string | null;
}

export interface PatchRunsqlDetailOptions {
  blockId?: string | null;
  blockIndex: number;
  sql: string;
  detailRaw: string;
}

interface LineInfo {
  line: string;
  start: number;
  end: number;
}

export function parseRunsqlFences(md: string): RunsqlFenceInfo[] {
  const lines = splitLinesWithOffsets(md);
  const results: RunsqlFenceInfo[] = [];

  let inFence = false;
  let fenceChar = "";
  let fenceLen = 0;
  let fenceLang = "";
  let codeStart = -1;
  let sqlStart = -1;
  let sqlEnd = -1;

  for (let i = 0; i < lines.length; i++) {
    const info = lines[i]!;
    const line = info.line;

    if (!inFence) {
      const open = line.match(/^(`{3,}|~{3,})([^\n]*)$/);
      if (!open) continue;
      const rawLang = (open[2] ?? "").trim().split(/\s+/)[0] ?? "";
      if (rawLang !== "runsql") continue;

      inFence = true;
      fenceChar = open[1]![0]!;
      fenceLen = open[1]!.length;
      fenceLang = rawLang;
      codeStart = info.start;
      sqlStart = info.end + 1;
      sqlEnd = sqlStart;
      continue;
    }

    const close = line.match(/^(`{3,}|~{3,})\s*$/);
    if (
      close &&
      close[1]![0] === fenceChar &&
      close[1]!.length >= fenceLen
    ) {
      const codeEnd = info.end;
      const sql = md.slice(sqlStart, sqlEnd).replace(/\n$/, "");
      const detailMatch = readFollowingDetail(md, lines, i + 1);

      results.push({
        index: results.length,
        codeStart,
        codeEnd,
        sql,
        detailStart: detailMatch?.start ?? null,
        detailEnd: detailMatch?.end ?? null,
        detail: detailMatch?.detail ?? null,
        detailRaw: detailMatch?.raw ?? null,
        blockId: detailMatch?.detail.blockId ?? null,
      });

      inFence = false;
      fenceChar = "";
      fenceLen = 0;
      fenceLang = "";
      codeStart = -1;
      sqlStart = -1;
      sqlEnd = -1;
      continue;
    }

    if (fenceLang === "runsql") {
      sqlEnd = info.end + 1;
    }
  }

  return results;
}

export function patchRunsqlDetail(
  md: string,
  opts: PatchRunsqlDetailOptions,
): string {
  const fences = parseRunsqlFences(md);
  const target = choosePatchTarget(fences, opts);
  if (!target) return md;

  if (target.detailStart !== null && target.detailEnd !== null) {
    return (
      md.slice(0, target.detailStart) +
      opts.detailRaw +
      md.slice(target.detailEnd)
    );
  }

  return md.slice(0, target.codeEnd) + "\n\n" + opts.detailRaw + md.slice(target.codeEnd);
}

function choosePatchTarget(
  fences: RunsqlFenceInfo[],
  opts: PatchRunsqlDetailOptions,
): RunsqlFenceInfo | null {
  if (opts.blockId) {
    const byBlockId = fences.find((f) => f.blockId === opts.blockId);
    if (byBlockId) return byBlockId;
  }

  const byIndex = fences.find((f) => f.index === opts.blockIndex);
  if (byIndex) return byIndex;

  const bySql = fences.filter((f) => f.sql.trim() === opts.sql.trim());
  return bySql.length === 1 ? bySql[0]! : null;
}

function readFollowingDetail(
  md: string,
  lines: LineInfo[],
  startLine: number,
):
  | {
      start: number;
      end: number;
      raw: string;
      detail: DetailMeta;
    }
  | null {
  for (let i = startLine; i < lines.length; i++) {
    const info = lines[i]!;
    const trimmed = info.line.trim();
    if (trimmed === "") continue;
    if (!trimmed.startsWith("<detail")) return null;

    const closeTag = "</detail>";
    const closeIdx = md.indexOf(closeTag, info.start);
    if (closeIdx < 0) return null;
    const end = closeIdx + closeTag.length;
    const raw = md.slice(info.start, end);
    const matched = matchDetail(raw);
    if (!matched) return null;
    return {
      start: info.start,
      end,
      raw: matched.full,
      detail: parseDetail(matched.inner),
    };
  }
  return null;
}

function splitLinesWithOffsets(md: string): LineInfo[] {
  const lines = md.split("\n");
  const result: LineInfo[] = [];
  let pos = 0;
  for (const line of lines) {
    const end = pos + line.length;
    result.push({ line, start: pos, end });
    pos = end + 1;
  }
  return result;
}
