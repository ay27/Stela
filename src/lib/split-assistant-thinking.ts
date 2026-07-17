/**
 * 把模型偶发夹带的 thinking / reasoning 标签块从正文里拆出来，
 * 供 Agent 时间线默认折叠展示。只认成对闭合的标签；未闭合的原样留在正文。
 *
 * 标签名匹配（大小写不敏感）：含 think / thinking / reasoning 子串即可
 * （如 think、thinking、thought、reasoning、redacted_reasoning）。
 */

const PAIRED_TAG_RE =
  /<\s*([A-Za-z][\w:.-]*)\b[^>]*>([\s\S]*?)<\/\s*\1\s*>/gi;

function isThinkingTagName(name: string): boolean {
  return /think|thinking|reasoning/i.test(name);
}

export function splitAssistantThinking(text: string): {
  thinking: string | null;
  body: string;
} {
  const thoughts: string[] = [];
  const body = text
    .replace(PAIRED_TAG_RE, (full, name: string, inner: string) => {
      if (!isThinkingTagName(name)) return full;
      const trimmed = inner.trim();
      if (trimmed) thoughts.push(trimmed);
      return "";
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return {
    thinking: thoughts.length > 0 ? thoughts.join("\n\n") : null,
    body,
  };
}
