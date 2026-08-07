import { useEffect, useMemo, useRef, useState } from "react";
import {
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
  useNodesState,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { ArrowDown, ArrowRight, Loader2, Lock, Move, WandSparkles } from "lucide-react";

import type { AnalysisCanvasFlowLayoutPatch } from "@shared/analysis-canvas";
import { useT } from "@/i18n/use-t";
import { cn } from "@/lib/utils";

import { layoutFlowCard, measureFlowNode, type FlowCard } from "./flow-layout";

interface FlowNodeData extends Record<string, unknown> {
  label: string;
  description?: string;
  kind: FlowCard["nodes"][number]["kind"];
  tone: NonNullable<FlowCard["nodes"][number]["tone"]>;
  direction: FlowCard["direction"];
  width: number;
  height: number;
  editing: boolean;
}

type StelaFlowNode = Node<FlowNodeData, "stela-flow">;

const toneClass: Record<FlowNodeData["tone"], string> = {
  neutral: "border-border bg-card",
  info: "border-blue-500/50 bg-blue-500/10",
  success: "border-emerald-500/50 bg-emerald-500/10",
  warning: "border-amber-500/50 bg-amber-500/10",
  danger: "border-destructive/50 bg-destructive/10",
};

function StelaFlowNodeView({ data, selected }: NodeProps<StelaFlowNode>) {
  const horizontal = data.direction === "LR";
  return <div className={cn(
    "relative flex flex-col justify-center border px-4 py-3 text-center shadow-sm",
    data.kind === "decision" ? "rounded-2xl" : data.kind === "note" ? "rounded-sm border-dashed" : "rounded-md",
    toneClass[data.tone], data.editing && selected && "ring-2 ring-primary/60",
  )} style={{ width: data.width, height: data.height }}>
    <Handle type="target" position={horizontal ? Position.Left : Position.Top} className={cn("!h-2 !w-2 !border-background !bg-muted-foreground", !data.editing && "!opacity-0")} />
    <div className="whitespace-normal break-words text-xs font-semibold leading-[18px]">{data.label}</div>
    {data.description ? <div className="mt-1 whitespace-normal break-words text-[10px] leading-4 text-muted-foreground">{data.description}</div> : null}
    <Handle type="source" position={horizontal ? Position.Right : Position.Bottom} className={cn("!h-2 !w-2 !border-background !bg-muted-foreground", !data.editing && "!opacity-0")} />
  </div>;
}

const nodeTypes = { "stela-flow": StelaFlowNodeView };

function rendererNodes(card: FlowCard, nodes: FlowCard["nodes"], editing: boolean): StelaFlowNode[] {
  return nodes.map((node) => {
    const size = measureFlowNode(node);
    return {
      id: node.id,
      type: "stela-flow",
      position: node.position ?? { x: 0, y: 0 },
      width: size.width,
      height: size.height,
      data: {
      label: node.label,
      description: node.description,
      kind: node.kind,
      tone: node.tone ?? (node.kind === "source" ? "info" : node.kind === "result" ? "success" : "neutral"),
      direction: card.direction,
      width: size.width,
      height: size.height,
      editing,
    },
    };
  });
}

function rendererEdges(card: FlowCard): Edge[] {
  return card.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    label: edge.label,
    type: "smoothstep",
    markerEnd: { type: MarkerType.ArrowClosed },
    animated: false,
    style: edge.tone === "danger" ? { stroke: "hsl(var(--destructive))" }
      : edge.tone === "success" ? { stroke: "rgb(16 185 129)" }
      : edge.tone === "warning" ? { stroke: "rgb(245 158 11)" }
      : undefined,
    labelStyle: { fontSize: 10, fill: "hsl(var(--muted-foreground))" },
  }));
}

export function FlowDiagramCard({
  card,
  onSave,
}: {
  card: FlowCard;
  onSave: (patch: AnalysisCanvasFlowLayoutPatch) => Promise<void>;
}) {
  const t = useT();
  const [nodes, setNodes, onNodesChange] = useNodesState<StelaFlowNode>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const instanceRef = useRef<ReactFlowInstance<StelaFlowNode, Edge> | null>(null);
  const edges = useMemo(() => rendererEdges(card), [card]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void layoutFlowCard(card, true).then((placed) => {
      if (!active) return;
      setNodes(rendererNodes(card, placed, editing));
      setLoading(false);
      window.setTimeout(() => void instanceRef.current?.fitView({ padding: 0.18, duration: 250 }), 0);
    }).catch((reason: unknown) => {
      if (active) { setError(reason instanceof Error ? reason.message : String(reason)); setLoading(false); }
    });
    return () => { active = false; };
  }, [card, editing, setNodes]);

  const save = async (patch: AnalysisCanvasFlowLayoutPatch) => {
    setSaving(true);
    setError(null);
    try { await onSave(patch); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setSaving(false); }
  };

  const autoLayout = async (direction: FlowCard["direction"]) => {
    if (saving) return;
    setLoading(true);
    try {
      const placed = await layoutFlowCard({ ...card, direction }, false);
      setNodes(rendererNodes({ ...card, direction }, placed, editing));
      await save({ direction, positions: placed.map((node) => ({ nodeId: node.id, position: node.position! })) });
      window.setTimeout(() => void instanceRef.current?.fitView({ padding: 0.18, duration: 250 }), 0);
    } finally { setLoading(false); }
  };

  if (loading && nodes.length === 0) return <div className="flex h-[440px] items-center justify-center rounded-lg border"><Loader2 className="h-4 w-4 animate-spin" /></div>;
  return <div className="space-y-1.5">
    <div className="flex items-center justify-end gap-1">
      {editing ? <>
        <button type="button" disabled={saving} className="rounded-sm border p-1.5 text-muted-foreground hover:text-foreground" title={t("analysisCanvas.flowTopBottom")} onClick={() => void autoLayout("TB")}><ArrowDown className="h-3.5 w-3.5" /></button>
        <button type="button" disabled={saving} className="rounded-sm border p-1.5 text-muted-foreground hover:text-foreground" title={t("analysisCanvas.flowLeftRight")} onClick={() => void autoLayout("LR")}><ArrowRight className="h-3.5 w-3.5" /></button>
        <button type="button" disabled={saving} className="rounded-sm border p-1.5 text-muted-foreground hover:text-foreground" title={t("analysisCanvas.flowAutoLayout")} onClick={() => void autoLayout(card.direction)}>{saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <WandSparkles className="h-3.5 w-3.5" />}</button>
      </> : null}
      <button
        type="button"
        role="switch"
        aria-checked={editing}
        disabled={saving}
        onClick={() => setEditing((value) => !value)}
        className={cn("ml-1 inline-flex h-7 items-center gap-1.5 rounded-sm border px-2 text-[11px]", editing ? "border-primary/40 bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground")}
        title={t(editing ? "analysisCanvas.flowFinishLayout" : "analysisCanvas.flowEditLayout")}
      >
        {editing ? <Move className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}
        {t(editing ? "analysisCanvas.flowFinishLayout" : "analysisCanvas.flowEditLayout")}
      </button>
    </div>
    {error ? <div className="rounded bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div> : null}
    <div className="h-[440px] overflow-hidden rounded-sm border bg-background">
      <ReactFlow<StelaFlowNode, Edge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onInit={(instance) => { instanceRef.current = instance; }}
        onNodeDragStop={(_event, node) => void save({ positions: [{ nodeId: node.id, position: node.position }] })}
        nodesDraggable={editing && !saving}
        nodesConnectable={false}
        edgesReconnectable={false}
        elementsSelectable={editing}
        deleteKeyCode={null}
        fitView
        minZoom={0.2}
        maxZoom={2}
      >
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  </div>;
}
