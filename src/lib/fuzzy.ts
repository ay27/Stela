/**
 * 极简子序列模糊匹配：query 的每个字符按顺序（可跳过中间字符）能在 target
 * 里依次找到即算命中，不要求连续。例如 query="shapegenfull" 能匹配
 * target="threed_datasets.shapegen_part_full_dataset"。
 *
 * 只用于前端小规模列表（几百到几千项）的即时过滤，没有做任何索引优化。
 */

export interface FuzzyMatch {
  /** 首个匹配字符在 target 中的位置，越靠前排序越靠前 */
  firstIndex: number;
  /** 匹配字符之间的"跳过"字符数之和，越连续（越像子串）分数越低 */
  score: number;
}

export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
  if (!query.trim()) return { firstIndex: 0, score: 0 };
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let searchFrom = 0;
  let firstIndex = -1;
  let lastIndex = -1;
  let gaps = 0;
  for (let i = 0; i < q.length; i++) {
    const found = t.indexOf(q[i]!, searchFrom);
    if (found === -1) return null;
    if (firstIndex === -1) firstIndex = found;
    if (lastIndex !== -1) gaps += found - lastIndex - 1;
    lastIndex = found;
    searchFrom = found + 1;
  }
  return { firstIndex, score: gaps * 2 + firstIndex };
}

export function fuzzyFilter<T>(
  query: string,
  items: readonly T[],
  getText: (item: T) => string,
  limit = 50,
): T[] {
  if (!query.trim()) return items.slice(0, limit);
  const scored: { item: T; score: number }[] = [];
  for (const item of items) {
    const m = fuzzyMatch(query, getText(item));
    if (m) scored.push({ item, score: m.score });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, limit).map((s) => s.item);
}
