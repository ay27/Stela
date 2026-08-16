const root = document.getElementById("report-root");
const errorBox = document.getElementById("report-error");

const labels = {
  pass: "通过",
  wrong_answer: "答案不匹配",
  mongodb_unavailable: "MongoDB 不可用",
  timeout: "超时",
  bridge_terminated: "Bridge 被终止",
  cross_database: "跨库限制",
  routing_error: "数据库路由错误",
  infrastructure: "运行环境错误",
  no_answer: "无最终答案",
  validation_failure: "验证失败",
};

const state = {
  data: null,
  dataset: "all",
  status: "all",
  category: "all",
  search: "",
  sort: "dataset",
  selected: null,
};

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatPercent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms)) return "—";
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes.toFixed(minutes < 10 ? 1 : 0)}m`;
  return `${(minutes / 60).toFixed(1)}h`;
}

function formatNumber(value) {
  return new Intl.NumberFormat("zh-CN").format(value);
}

function compactNumber(value) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

function categoryLabel(category) {
  return labels[category] ?? category;
}

function metric(label, value, note) {
  const card = element("article", "stela-metric");
  card.append(element("div", "stela-metric-label", label));
  card.append(element("div", "stela-metric-value", value));
  card.append(element("div", "stela-metric-note", note));
  return card;
}

function filteredCases() {
  const query = state.search.trim().toLowerCase();
  const rows = state.data.cases.filter((item) => {
    if (state.dataset !== "all" && item.dataset !== state.dataset) return false;
    if (state.status === "pass" && !item.valid) return false;
    if (state.status === "fail" && item.valid) return false;
    if (state.category !== "all" && item.failureCategory !== state.category) return false;
    if (!query) return true;
    return [item.id, item.question, item.answer, item.validationReason, item.groundTruth]
      .some((value) => String(value ?? "").toLowerCase().includes(query));
  });
  return rows.sort((a, b) => {
    if (state.sort === "duration-desc") return b.elapsedMs - a.elapsedMs;
    if (state.sort === "tools-desc") return b.toolCalls - a.toolCalls;
    if (state.sort === "tokens-desc") {
      const tokenA = a.usage.inputTokens + a.usage.outputTokens + a.usage.cacheReadTokens;
      const tokenB = b.usage.inputTokens + b.usage.outputTokens + b.usage.cacheReadTokens;
      return tokenB - tokenA;
    }
    return a.dataset.localeCompare(b.dataset) || a.query - b.query || a.run - b.run;
  });
}

function renderSummary() {
  const target = document.getElementById("summary");
  const totals = state.data.totals;
  target.replaceChildren(
    metric("通过率", `${totals.valid} / ${totals.cases}`, formatPercent(totals.validRate)),
    metric("平均耗时", formatDuration(totals.averageElapsedMs), `累计 ${formatDuration(totals.elapsedMs)}`),
    metric("工具调用", formatNumber(totals.toolCalls), `平均 ${(totals.toolCalls / totals.cases).toFixed(1)} / case`),
    metric("模型输出 Token", compactNumber(totals.outputTokens), `${formatNumber(totals.modelTurns)} 个模型轮次`),
    metric("Prompt Cache", totals.cacheHitRate == null ? "—" : formatPercent(totals.cacheHitRate), `${compactNumber(totals.cacheReadTokens)} cached tokens`),
  );
}

function renderSignals() {
  const failures = state.data.cases.filter((item) => !item.valid);
  const mongo = failures.filter((item) => item.failureCategory === "mongodb_unavailable");
  const timeout = failures.filter((item) => ["timeout", "bridge_terminated"].includes(item.failureCategory));
  const validation = failures.filter((item) => item.failureCategory === "validation_failure");
  const emptyContextTools = ["search_vault", "search_skills", "list_vault_files", "read_note", "search_sql_usage", "read_analysis_canvas"];
  const emptyContextCalls = state.data.toolStats
    .filter((item) => emptyContextTools.includes(item.tool))
    .reduce((sum, item) => sum + item.calls, 0);
  const signals = [
    {
      value: `${mongo.length} cases`,
      text: `失败轨迹触发 MongoDB 不可用，覆盖 ${new Set(mongo.map((item) => item.dataset)).size} 个数据集。`,
      className: "stela-signal-danger",
    },
    {
      value: `${timeout.length} cases`,
      text: "显式超时或 bridge 被硬终止；现在会保留根因并立即结束对应 run。",
      className: "stela-signal-danger",
    },
    {
      value: `${validation.length} cases`,
      text: "数据库可以访问、流程完成，但最终数字、名称或实体与 ground truth 不匹配。",
      className: "stela-signal-warning",
    },
    {
      value: `${emptyContextCalls} calls`,
      text: "空 Vault 下仍调用检索、Skill、文件和历史 SQL 工具，是可直接消除的探索开销。",
      className: "",
    },
  ];
  const target = document.getElementById("signals");
  target.replaceChildren(...signals.map((item) => {
    const card = element("article", `stela-signal ${item.className}`.trim());
    card.append(element("strong", "", item.value), element("span", "", item.text));
    return card;
  }));
}

function setDatasetFilter(dataset) {
  state.dataset = dataset;
  document.getElementById("dataset-filter").value = dataset;
  renderExplorer();
}

function renderDatasetChart() {
  const target = document.getElementById("dataset-chart");
  const rows = [...state.data.datasets].sort((a, b) => a.validRate - b.validRate || b.cases - a.cases);
  target.replaceChildren(...rows.map((item) => {
    const button = element("button", "stela-dataset-row");
    button.type = "button";
    button.title = `${item.name}: ${item.valid}/${item.cases}`;
    button.addEventListener("click", () => setDatasetFilter(item.name));
    const track = element("span", "stela-bar-track");
    const fill = element("span", "stela-bar-fill");
    fill.style.width = `${item.validRate * 100}%`;
    track.append(fill);
    button.append(
      element("span", "stela-dataset-name", item.name),
      track,
      element("span", "stela-bar-rate", formatPercent(item.validRate)),
      element("span", "stela-bar-count", `${item.valid}/${item.cases}`),
    );
    return button;
  }));
}

function setCategoryFilter(category) {
  state.category = category;
  state.status = category === "all" ? state.status : "fail";
  document.getElementById("category-filter").value = category;
  document.getElementById("status-filter").value = state.status;
  renderExplorer();
}

function renderFailureChart() {
  const target = document.getElementById("failure-chart");
  const max = Math.max(...state.data.failureCategories.map((item) => item.count), 1);
  target.replaceChildren(...state.data.failureCategories.map((item) => {
    const button = element("button", "stela-failure-row");
    button.type = "button";
    button.addEventListener("click", () => setCategoryFilter(item.category));
    const meta = element("span", "stela-failure-meta");
    meta.append(
      element("span", "stela-failure-label", categoryLabel(item.category)),
      element("span", "", `${item.count} cases`),
    );
    const track = element("span", "stela-failure-track");
    const fill = element("span", "stela-failure-fill");
    fill.style.width = `${(item.count / max) * 100}%`;
    track.append(fill);
    button.append(meta, track);
    return button;
  }));
}

function svgNode(tag, attributes = {}) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
  return node;
}

function renderScatter() {
  const target = document.getElementById("scatter-chart");
  const width = 920;
  const height = 280;
  const margin = { left: 54, right: 18, top: 14, bottom: 38 };
  const rows = state.data.cases;
  const maxTools = Math.max(...rows.map((item) => item.toolCalls), 1);
  const maxMinutes = Math.max(...rows.map((item) => item.elapsedMs / 60_000), 1);
  const x = (value) => margin.left + (value / maxTools) * (width - margin.left - margin.right);
  const y = (value) => height - margin.bottom - (value / maxMinutes) * (height - margin.top - margin.bottom);
  const svg = svgNode("svg", { viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": "工具调用次数与耗时散点图" });
  for (let index = 0; index <= 4; index += 1) {
    const minutes = maxMinutes * index / 4;
    const yy = y(minutes);
    svg.append(svgNode("line", { x1: margin.left, y1: yy, x2: width - margin.right, y2: yy, class: "stela-grid" }));
    const label = svgNode("text", { x: margin.left - 8, y: yy + 3, "text-anchor": "end" });
    label.textContent = `${minutes.toFixed(0)}m`;
    svg.append(label);
  }
  for (let index = 0; index <= 5; index += 1) {
    const calls = maxTools * index / 5;
    const xx = x(calls);
    svg.append(svgNode("line", { x1: xx, y1: margin.top, x2: xx, y2: height - margin.bottom, class: "stela-grid" }));
    const label = svgNode("text", { x: xx, y: height - 16, "text-anchor": "middle" });
    label.textContent = calls.toFixed(0);
    svg.append(label);
  }
  svg.append(svgNode("line", { x1: margin.left, y1: height - margin.bottom, x2: width - margin.right, y2: height - margin.bottom, class: "stela-axis" }));
  const xLabel = svgNode("text", { x: (width + margin.left - margin.right) / 2, y: height - 2, "text-anchor": "middle" });
  xLabel.textContent = "工具调用次数";
  svg.append(xLabel);
  const yLabel = svgNode("text", { x: 12, y: 12 });
  yLabel.textContent = "耗时（分钟）";
  svg.append(yLabel);
  for (const item of rows) {
    const point = svgNode("circle", {
      cx: x(item.toolCalls),
      cy: y(item.elapsedMs / 60_000),
      r: state.selected === item.id ? 7 : 4.5,
      fill: item.valid ? "var(--stela-pass)" : "var(--stela-fail)",
      opacity: item.valid ? 0.72 : 0.82,
      "data-selected": state.selected === item.id ? "true" : "false",
      tabindex: 0,
    });
    const title = svgNode("title");
    title.textContent = `${item.id}\n${item.valid ? "通过" : categoryLabel(item.failureCategory)}\n${item.toolCalls} tools · ${formatDuration(item.elapsedMs)}`;
    point.append(title);
    const select = () => {
      state.selected = item.id;
      renderExplorer();
      renderScatter();
      document.getElementById("case-detail").scrollIntoView({ behavior: "smooth", block: "start" });
    };
    point.addEventListener("click", select);
    point.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") select();
    });
    svg.append(point);
  }
  target.replaceChildren(svg);
}

function statusNode(item) {
  const status = element("span", `stela-status ${item.valid ? "stela-status-pass" : "stela-status-fail"}`);
  status.append(element("i", `stela-dot ${item.valid ? "stela-dot-pass" : "stela-dot-fail"}`));
  status.append(document.createTextNode(item.valid ? "通过" : "失败"));
  return status;
}

function traceStepNode(step, index) {
  const details = element("details", "stela-trace-step");
  details.dataset.error = String(step.isError);
  const toolNames = step.toolCalls.map((call) => call.name).join(", ");
  const title = step.role === "tool"
    ? `#${index + 1} Tool · ${step.toolName}${step.isError ? " · ERROR" : ""}`
    : step.role === "user"
      ? `#${index + 1} User context`
      : `#${index + 1} Assistant${toolNames ? ` · ${toolNames}` : ""}`;
  details.append(element("summary", "", title));
  const body = element("div", "stela-trace-body");
  if (step.usage) {
    body.append(element("div", "stela-muted", `usage: ${step.usage.input} input · ${step.usage.output} output · ${step.usage.cacheRead} cached`));
  }
  if (step.thinking) {
    const group = element("div", "");
    group.append(element("div", "stela-trace-label", "Reasoning"));
    group.append(element("pre", "", step.thinking));
    body.append(group);
  }
  for (const call of step.toolCalls) {
    const group = element("div", "stela-tool-call");
    group.append(element("div", "stela-trace-label", call.name));
    group.append(element("pre", "", call.arguments));
    body.append(group);
  }
  if (step.text) {
    const group = element("div", "");
    group.append(element("div", "stela-trace-label", step.role === "tool" ? "Result" : "Message"));
    group.append(element("pre", "", step.text));
    body.append(group);
  }
  details.append(body);
  return details;
}

function detailBlock(title, text, className = "") {
  const block = element("section", `stela-detail-block ${className}`.trim());
  block.append(element("h4", "", title), element("pre", "", text || "—"));
  return block;
}

function renderDetail(item) {
  const target = document.getElementById("case-detail");
  if (!item) {
    target.replaceChildren(element("div", "stela-detail-empty", "选择一个 case 查看问题、答案和完整执行轨迹。"));
    return;
  }
  const head = element("div", "stela-detail-head");
  const titleRow = element("div", "stela-detail-title-row");
  titleRow.append(element("h3", "", item.id), statusNode(item));
  const metrics = element("div", "stela-detail-metrics");
  const metricValues = [
    ["耗时", formatDuration(item.elapsedMs)],
    ["首次结果", item.firstResultMs == null ? "—" : formatDuration(item.firstResultMs)],
    ["模型轮次", String(item.modelTurns)],
    ["工具调用", String(item.toolCalls)],
  ];
  for (const [label, value] of metricValues) {
    const card = element("div", "stela-detail-metric");
    card.append(element("span", "", label), element("strong", "", value));
    metrics.append(card);
  }
  head.append(titleRow, metrics);
  const validation = element("section", "stela-detail-block");
  validation.append(element("h4", "", "VALIDATOR"));
  validation.append(element("pre", item.valid ? "" : "stela-validation", item.validationReason || "—"));
  if (item.groundTruth) {
    const truth = element("div", "stela-ground-truth");
    truth.append(element("div", "stela-trace-label", "Ground truth"), element("pre", "", item.groundTruth));
    validation.append(truth);
  }
  if (item.error) validation.append(element("pre", "stela-validation", item.error));
  const trace = element("section", "stela-trace");
  trace.append(element("h4", "", `执行轨迹 · ${item.trace.length} steps`));
  trace.append(...item.trace.map(traceStepNode));
  target.replaceChildren(
    head,
    detailBlock("问题", item.question),
    validation,
    detailBlock("最终回答", item.answer),
    trace,
  );
}

function renderExplorer() {
  const rows = filteredCases();
  if (!rows.some((item) => item.id === state.selected)) state.selected = rows[0]?.id ?? null;
  document.getElementById("case-count").textContent = `${rows.length} / ${state.data.cases.length} cases`;
  const body = document.getElementById("case-list");
  body.replaceChildren(...rows.map((item) => {
    const row = element("tr", "");
    row.dataset.selected = String(item.id === state.selected);
    row.tabIndex = 0;
    const values = [
      element("span", "stela-case-id", `${item.dataset} · Q${item.query}`),
      statusNode(item),
      formatDuration(item.elapsedMs),
      String(item.toolCalls),
      String(item.modelTurns),
      item.valid ? "—" : categoryLabel(item.failureCategory),
    ];
    values.forEach((value, index) => {
      const cell = element("td", index === 5 ? "stela-category" : "");
      if (value instanceof Node) cell.append(value);
      else cell.textContent = value;
      row.append(cell);
    });
    const select = () => {
      state.selected = item.id;
      renderExplorer();
      renderScatter();
    };
    row.addEventListener("click", select);
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") select();
    });
    return row;
  }));
  renderDetail(rows.find((item) => item.id === state.selected));
}

function renderToolStats() {
  const target = document.getElementById("tool-stats");
  target.replaceChildren(...state.data.toolStats.map((item) => {
    const card = element("article", "stela-tool-card");
    const counts = element("div", "stela-tool-counts");
    counts.append(
      element("span", "stela-status-pass", `${item.passCalls} pass`),
      element("span", "stela-status-fail", `${item.failCalls} fail`),
      element("span", "stela-tool-total", formatNumber(item.calls)),
    );
    card.append(element("div", "stela-tool-name", item.tool), counts);
    return card;
  }));
}

function setupFilters() {
  const dataset = document.getElementById("dataset-filter");
  dataset.replaceChildren(new Option("全部数据集", "all"), ...state.data.datasets.map((item) => new Option(item.name, item.name)));
  const category = document.getElementById("category-filter");
  category.replaceChildren(new Option("全部失败类别", "all"), ...state.data.failureCategories.map((item) => new Option(categoryLabel(item.category), item.category)));
  dataset.addEventListener("change", (event) => { state.dataset = event.target.value; renderExplorer(); });
  document.getElementById("status-filter").addEventListener("change", (event) => { state.status = event.target.value; renderExplorer(); });
  category.addEventListener("change", (event) => { state.category = event.target.value; renderExplorer(); });
  document.getElementById("sort-filter").addEventListener("change", (event) => { state.sort = event.target.value; renderExplorer(); });
  document.getElementById("case-search").addEventListener("input", (event) => { state.search = event.target.value; renderExplorer(); });
}

async function main() {
  const response = await fetch("./analysis-data.json");
  if (!response.ok) throw new Error(`无法读取 analysis-data.json (${response.status})`);
  state.data = await response.json();
  const model = state.data.manifest.model ?? state.data.cases[0]?.model ?? "unknown model";
  const generated = state.data.sourceGeneratedAt ? new Date(state.data.sourceGeneratedAt).toLocaleString("zh-CN") : "未知时间";
  document.getElementById("report-meta").textContent = `${model} · ${state.data.totals.cases} cases · 完成于 ${generated}`;
  setupFilters();
  renderSummary();
  renderSignals();
  renderDatasetChart();
  renderFailureChart();
  renderScatter();
  renderExplorer();
  renderToolStats();
}

main().catch((error) => {
  root.hidden = true;
  errorBox.hidden = false;
  errorBox.textContent = `报告加载失败\n${error instanceof Error ? error.message : String(error)}\n\n请通过本地 HTTP server 打开，不要直接使用 file://。`;
});
