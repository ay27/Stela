export interface TemplateCommandTargetIdentity {
  tabId: string | null;
  blockId: string | null;
  blockIndex: number;
  text: string;
}

export interface TemplateCommandTargetCandidate {
  tabId: string | null;
  blockId: string | null;
  blockIndex: number;
  text: string;
  connected: boolean;
}

/** Match the replacement NodeView created while the template picker is open. */
export function matchesTemplateCommandTarget(
  target: TemplateCommandTargetIdentity,
  candidate: TemplateCommandTargetCandidate,
): boolean {
  if (
    !candidate.connected ||
    candidate.tabId !== target.tabId ||
    candidate.text !== target.text
  ) {
    return false;
  }
  if (target.blockId !== null) return candidate.blockId === target.blockId;
  return candidate.blockIndex === target.blockIndex;
}
