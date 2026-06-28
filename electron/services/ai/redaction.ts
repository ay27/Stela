const SECRET_KEY_PATTERN =
  /\b(password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key|authorization|bearer)\b/i;

const VALUE_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\b(api[_-]?key|token|secret|password)\s*[:=]\s*['"]?[^'",\s)]+/gi,
];

const REDACTED = "***redacted***";

function redactText(input: string): string {
  let out = input;
  for (const pattern of VALUE_PATTERNS) {
    out = out.replace(pattern, (match) => {
      const idx = match.search(/[:=]/);
      if (idx >= 0) return `${match.slice(0, idx + 1)} ${REDACTED}`;
      return REDACTED;
    });
  }
  return out;
}

export function redactForPrompt<T>(value: T): T {
  if (typeof value === "string") return redactText(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactForPrompt(item)) as T;
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : redactForPrompt(nested);
  }
  return out as T;
}

