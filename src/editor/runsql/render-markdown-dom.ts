function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function renderInlineInto(parent: HTMLElement, text: string): void {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  for (const part of parts) {
    if (!part) continue;
    if (/^`[^`]+`$/.test(part)) {
      const code = document.createElement("code");
      code.className = "stela-cb__ai-md-inline-code";
      code.textContent = part.slice(1, -1);
      parent.append(code);
      continue;
    }
    if (/^\*\*[^*]+\*\*$/.test(part)) {
      const strong = document.createElement("strong");
      strong.textContent = part.slice(2, -2);
      parent.append(strong);
      continue;
    }
    parent.append(document.createTextNode(part));
  }
}

/** 将 Markdown 渲染为只读 DOM（headings / lists / tables / code / inline）。 */
export function renderMarkdownIntoDom(
  container: HTMLElement,
  markdown: string,
): void {
  container.replaceChildren();
  const lines = markdown.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const lang = fence[1] ?? "";
      const pre = document.createElement("pre");
      pre.className = "stela-cb__ai-md-code";
      if (lang) {
        const label = document.createElement("div");
        label.className = "stela-cb__ai-md-code-lang";
        label.textContent = lang;
        pre.append(label);
      }
      const code = document.createElement("code");
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i] ?? "")) {
        buf.push(lines[i] ?? "");
        i += 1;
      }
      i += 1;
      code.textContent = buf.join("\n");
      pre.append(code);
      container.append(pre);
      continue;
    }
    if (!line.trim()) {
      i += 1;
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      const el = document.createElement("div");
      el.className = `stela-cb__ai-md-heading stela-cb__ai-md-heading--${heading[1]!.length}`;
      renderInlineInto(el, heading[2] ?? "");
      container.append(el);
      i += 1;
      continue;
    }
    if (
      /^\|.+\|$/.test(line) &&
      /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(lines[i + 1] ?? "")
    ) {
      const header = splitTableRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\|.+\|$/.test(lines[i] ?? "")) {
        rows.push(splitTableRow(lines[i] ?? ""));
        i += 1;
      }
      const wrap = document.createElement("div");
      wrap.className = "stela-cb__ai-md-table-wrap";
      const table = document.createElement("table");
      table.className = "stela-cb__ai-md-table";
      const thead = document.createElement("thead");
      const headRow = document.createElement("tr");
      for (const cell of header) {
        const th = document.createElement("th");
        renderInlineInto(th, cell);
        headRow.append(th);
      }
      thead.append(headRow);
      table.append(thead);
      const tbody = document.createElement("tbody");
      for (const row of rows) {
        const tr = document.createElement("tr");
        for (const cell of row) {
          const td = document.createElement("td");
          renderInlineInto(td, cell);
          tr.append(td);
        }
        tbody.append(tr);
      }
      table.append(tbody);
      wrap.append(table);
      container.append(wrap);
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      const ul = document.createElement("ul");
      ul.className = "stela-cb__ai-md-list";
      while (i < lines.length && /^[-*]\s+/.test(lines[i] ?? "")) {
        const li = document.createElement("li");
        renderInlineInto(li, (lines[i] ?? "").replace(/^[-*]\s+/, ""));
        ul.append(li);
        i += 1;
      }
      container.append(ul);
      continue;
    }
    if (/^>\s?/.test(line)) {
      const blockquote = document.createElement("blockquote");
      blockquote.className = "stela-cb__ai-md-quote";
      while (i < lines.length && /^>\s?/.test(lines[i] ?? "")) {
        const qLine = (lines[i] ?? "").replace(/^>\s?/, "");
        if (blockquote.childNodes.length > 0) {
          blockquote.append(document.createElement("br"));
        }
        const span = document.createElement("span");
        renderInlineInto(span, qLine);
        blockquote.append(span);
        i += 1;
      }
      container.append(blockquote);
      continue;
    }
    const para: string[] = [line];
    i += 1;
    while (
      i < lines.length &&
      (lines[i] ?? "").trim() &&
      !/^```/.test(lines[i] ?? "") &&
      !/^(#{1,3})\s+/.test(lines[i] ?? "") &&
      !/^[-*]\s+/.test(lines[i] ?? "") &&
      !/^>\s?/.test(lines[i] ?? "") &&
      !(/^\|.+\|$/.test(lines[i] ?? "") &&
        /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(lines[i + 1] ?? ""))
    ) {
      para.push(lines[i] ?? "");
      i += 1;
    }
    const p = document.createElement("p");
    renderInlineInto(p, para.join(" "));
    container.append(p);
  }
}
