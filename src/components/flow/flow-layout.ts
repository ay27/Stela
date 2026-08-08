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

export type FlowSceneNode = FlowNode & {
  position: { x: number; y: number };
  size: FlowNodeSize;
};

export interface FlowSceneEdge {
  edge: FlowCard["edges"][number];
  path: string;
  labelPosition: { x: number; y: number };
}

export interface FlowScene {
  width: number;
  height: number;
  nodes: FlowSceneNode[];
  edges: FlowSceneEdge[];
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

/**
 * 把已布局节点归一化到一个自然尺寸场景。Canvas 只读预览和 HTML 导出共享
 * 这套边界、连线和留白计算，避免两个展示面产生不同的缩放体验。
 */
export function buildFlowScene(
  card: FlowCard,
  nodes: FlowCard["nodes"],
  padding = 36,
): FlowScene {
  if (nodes.length === 0) return { width: 0, height: 0, nodes: [], edges: [] };
  const sizedNodes = nodes.map((node) => ({
    ...node,
    position: node.position ?? { x: 0, y: 0 },
    size: measureFlowNode(node),
  }));
  const minX = Math.min(...sizedNodes.map((node) => node.position.x));
  const minY = Math.min(...sizedNodes.map((node) => node.position.y));
  const maxX = Math.max(...sizedNodes.map((node) => node.position.x + node.size.width));
  const maxY = Math.max(...sizedNodes.map((node) => node.position.y + node.size.height));
  const sceneNodes = sizedNodes.map((node) => ({
    ...node,
    position: {
      x: node.position.x - minX + padding,
      y: node.position.y - minY + padding,
    },
  }));
  const byId = new Map(sceneNodes.map((node) => [node.id, node]));
  const horizontal = card.direction === "LR";
  const edges = card.edges.flatMap((edge): FlowSceneEdge[] => {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target) return [];
    const sx = source.position.x + (horizontal ? source.size.width : source.size.width / 2);
    const sy = source.position.y + (horizontal ? source.size.height / 2 : source.size.height);
    const tx = target.position.x + (horizontal ? 0 : target.size.width / 2);
    const ty = target.position.y + (horizontal ? target.size.height / 2 : 0);
    const middle = horizontal ? (sx + tx) / 2 : (sy + ty) / 2;
    return [{
      edge,
      path: horizontal
        ? `M ${sx} ${sy} C ${middle} ${sy}, ${middle} ${ty}, ${tx} ${ty}`
        : `M ${sx} ${sy} C ${sx} ${middle}, ${tx} ${middle}, ${tx} ${ty}`,
      labelPosition: { x: (sx + tx) / 2, y: (sy + ty) / 2 - 6 },
    }];
  });
  return {
    width: maxX - minX + padding * 2,
    height: maxY - minY + padding * 2,
    nodes: sceneNodes,
    edges,
  };
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
