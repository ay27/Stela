/** Regression fixture based on the failed multi-step pipeline shape; no Vault data. */
export const pipelineAuthoringFixture = {
  title: "流程回归", sources: [], sections: [{ id: "pipeline", title: "主链", cards: [
    { id: "flow", type: "flow", title: "流程图", direction: "LR",
      nodes: Array.from({ length: 20 }, (_, i) => ({ id: `n${i}`, kind: i === 0 ? "source" : i === 19 ? "result" : "step", label: `步骤 ${i + 1}` })),
      edges: Array.from({ length: 20 }, (_, i) => ({ id: `e${i}`, source: `n${i}`, target: `n${(i + 1) % 20}` })),
    },
    { id: "explanation", type: "markdown", markdown: "流程说明：已核对结构。" },
  ] }],
};
export const mixedAuthoringFixture = {
  ...pipelineAuthoringFixture, title: "混合卡片回归", sources: [{ id: "data", title: "数据" }],
  sections: [{ ...pipelineAuthoringFixture.sections[0], cards: [
    ...pipelineAuthoringFixture.sections[0]!.cards,
    { id: "table", type: "table", title: "结果表格", sourceId: "data", columns: [{ field: "category" }, { field: "total" }] },
    { id: "kpi", type: "kpi", title: "总量", sourceId: "data", value: { field: "total" } },
    { id: "chart", type: "chart", title: "分类图", sourceId: "data", chart: {
      preset: "comparison", fields: { category: { field: "category", type: "nominal" }, total: { field: "total", type: "quantitative" } },
      layers: [{ mark: "bar", encoding: { x: "category", y: "total" } }],
    } },
  ] }],
};
