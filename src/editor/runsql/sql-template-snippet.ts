export interface TemplateVariableField {
  name: string;
  ranges: Array<{ from: number; to: number }>;
}

export interface TemplateVariableSession {
  text: string;
  fields: TemplateVariableField[];
}

export interface TemplateInsertion extends TemplateVariableSession {
  cursor: number;
}

/**
 * 保留并选中完整的 `{{变量}}` 占位符。CodeMirror 原生 snippet 的同名 placeholder
 * 只共享默认文案、不会联动后续输入；因此由 NodeView 用多选区实现联动，并在
 * Tab/Shift+Tab 时在 fields 间切换。用户输入时会一次替换所有同名占位符。
 */
export function createTemplateVariableSession(sql: string): TemplateVariableSession {
  const fields = new Map<string, TemplateVariableField>();
  let text = "";
  let last = 0;
  const pattern = /\{\{([^{}\r\n]+)\}\}/g;
  for (let match = pattern.exec(sql); match; match = pattern.exec(sql)) {
    const name = match[1]!.trim();
    if (!name) continue;
    text += sql.slice(last, match.index);
    const from = text.length;
    text += match[0];
    const field = fields.get(name) ?? { name, ranges: [] };
    field.ranges.push({ from, to: text.length });
    fields.set(name, field);
    last = match.index + match[0].length;
  }
  return { text: text + sql.slice(last), fields: [...fields.values()] };
}

/** 在当前 SQL 文本中生成一次完整替换；fields 坐标均相对替换后的全文。 */
export function createTemplateInsertion(
  text: string,
  from: number,
  to: number,
  sql: string,
): TemplateInsertion {
  const session = createTemplateVariableSession(sql);
  return {
    text: text.slice(0, from) + session.text + text.slice(to),
    cursor: from + session.text.length,
    fields: session.fields.map((field) => ({
      name: field.name,
      ranges: field.ranges.map((range) => ({
        from: from + range.from,
        to: from + range.to,
      })),
    })),
  };
}

/** 纯函数版的联动替换，供测试验证同一变量的所有范围。 */
export function applyTemplateVariableValue(
  session: TemplateVariableSession,
  fieldIndex: number,
  value: string,
): string {
  const field = session.fields[fieldIndex];
  if (!field) return session.text;
  let text = session.text;
  for (const range of [...field.ranges].reverse()) {
    text = text.slice(0, range.from) + value + text.slice(range.to);
  }
  return text;
}
