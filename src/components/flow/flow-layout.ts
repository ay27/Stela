import type { AnalysisCanvasCard } from "@shared/analysis-canvas";

export const FLOW_NODE_MIN_WIDTH = 260;
export const FLOW_NODE_MAX_WIDTH = 420;
export const FLOW_NODE_MIN_HEIGHT = 86;

export type FlowCard = Extract<AnalysisCanvasCard, { type: "flow" }>;
export type FlowNode = FlowCard["nodes"][number];

export interface FlowNodeSize {
  width: number;
  height: number;
}

function visualUnits(value: string): number {
  return [...value].reduce((total, character) => total + (/^[\u0000-\u00ff]$/.test(character) ? 0.58 : 1), 0);
}

/**
 * Flow 内容由 Agent 生成，尺寸由 Stela 根据文字稳定推导。这样不用把纯展示
 * 尺寸写入 Canvas，同时交互视图、Dagre 和静态导出仍使用同一套几何信息。
 */
export function measureFlowNode(node: FlowNode): FlowNodeSize {
  const labelUnits = visualUnits(node.label);
  const descriptionUnits = visualUnits(node.description ?? "");
  const contentSignal = Math.max(labelUnits * 5.5, Math.sqrt(descriptionUnits) * 18);
  const width = Math.round(Math.min(FLOW_NODE_MAX_WIDTH, Math.max(FLOW_NODE_MIN_WIDTH, 220 + contentSignal)));
  const labelLines = Math.max(1, Math.ceil(labelUnits / Math.max(12, (width - 36) / 7.5)));
  const descriptionLines = node.description
    ? Math.max(1, Math.ceil(descriptionUnits / Math.max(16, (width - 36) / 6.2)))
    : 0;
  const height = Math.max(FLOW_NODE_MIN_HEIGHT, 38 + labelLines * 18 + descriptionLines * 16);
  return { width, height };
}

export async function layoutFlowCard(card: FlowCard, preservePositions: boolean): Promise<FlowCard["nodes"]> {
  const dagre = (await import("@dagrejs/dagre")).default;
  const graph = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  graph.setGraph({
    rankdir: card.direction,
    ranksep: card.direction === "TB" ? 72 : 100,
    nodesep: 48,
    marginx: 24,
    marginy: 24,
  });
  for (const node of card.nodes) graph.setNode(node.id, measureFlowNode(node));
  for (const edge of card.edges) graph.setEdge(edge.source, edge.target);
  dagre.layout(graph);
  return card.nodes.map((node) => {
    if (preservePositions && node.position) return node;
    const placed = graph.node(node.id) as { x: number; y: number } | undefined;
    const size = measureFlowNode(node);
    return {
      ...node,
      position: placed
        ? { x: placed.x - size.width / 2, y: placed.y - size.height / 2 }
        : { x: 0, y: 0 },
    };
  });
}
