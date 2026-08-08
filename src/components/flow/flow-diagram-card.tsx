import { useEffect, useId, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
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
  type ReactFlowProps,
  useNodesState,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { ArrowDown, ArrowRight, Loader2, Lock, Maximize2, Move, WandSparkles, X } from "lucide-react";

import type { AnalysisCanvasFlowLayoutPatch } from "@shared/analysis-canvas";
import { useT } from "@/i18n/use-t";
import { cn } from "@/lib/utils";

import { buildFlowScene, layoutFlowCard, measureFlowNode, type FlowCard } from "./flow-layout";

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

const edgeStroke: Record<NonNullable<FlowCard["edges"][number]["tone"]>, string> = {
  neutral: "hsl(var(--muted-foreground))",
  success: "rgb(16 185 129)",
  warning: "rgb(245 158 11)",
  danger: "hsl(var(--destructive))",
};

function nodeTone(node: FlowCard["nodes"][number]): FlowNodeData["tone"] {
  return node.tone ?? (node.kind === "source" ? "info" : node.kind === "result" ? "success" : "neutral");
}

function ReadOnlyFlowPreview({ card, nodes }: { card: FlowCard; nodes: FlowCard["nodes"] }) {
  const id = useId().replace(/:/g, "");
  const scene = useMemo(() => buildFlowScene(card, nodes), [card, nodes]);
  const markerId = (tone: NonNullable<FlowCard["edges"][number]["tone"]>) => `${id}-${tone}`;

  if (scene.nodes.length === 0) return <div className="flex min-h-24 items-center justify-center rounded-sm border text-xs text-muted-foreground">—</div>;
  return <div
    className="max-h-[440px] overflow-auto overscroll-contain rounded-sm border bg-background"
    role="img"
    aria-label={card.title}
    tabIndex={0}
  >
    <div className="relative mx-auto shrink-0" style={{ width: scene.width, height: scene.height }}>
      <svg className="pointer-events-none absolute inset-0 max-w-none" width={scene.width} height={scene.height} viewBox={`0 0 ${scene.width} ${scene.height}`} aria-hidden="true">
        <defs>
          {(Object.keys(edgeStroke) as Array<keyof typeof edgeStroke>).map((tone) => <marker key={tone} id={markerId(tone)} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill={edgeStroke[tone]} /></marker>)}
        </defs>
        {scene.edges.map(({ edge, path, labelPosition }) => {
          const tone = edge.tone ?? "neutral";
          return <g key={edge.id}>
            <path d={path} fill="none" stroke={edgeStroke[tone]} strokeWidth={1.5} markerEnd={`url(#${markerId(tone)})`} />
            {edge.label ? <text x={labelPosition.x} y={labelPosition.y} textAnchor="middle" fontSize={10} fill="hsl(var(--muted-foreground))">{edge.label}</text> : null}
          </g>;
        })}
      </svg>
      {scene.nodes.map((node) => <div
        key={node.id}
        className={cn(
          "absolute flex flex-col items-center justify-center border px-4 py-3 text-center shadow-sm",
          node.kind === "decision" ? "rounded-2xl" : node.kind === "note" ? "rounded-sm border-dashed" : "rounded-md",
          toneClass[nodeTone(node)],
        )}
        style={{ left: node.position.x, top: node.position.y, width: node.size.width, height: node.size.height }}
      >
        <div className="whitespace-normal break-words text-xs font-semibold leading-[18px]">{node.label}</div>
        {node.description ? <div className="mt-1 whitespace-normal break-words text-[10px] leading-4 text-muted-foreground">{node.description}</div> : null}
      </div>)}
    </div>
  </div>;
}

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

interface FlowViewportProps {
  className: string;
  nodes: StelaFlowNode[];
  edges: Edge[];
  editing: boolean;
  saving: boolean;
  onNodesChange: NonNullable<ReactFlowProps<StelaFlowNode, Edge>["onNodesChange"]>;
  onInit: NonNullable<ReactFlowProps<StelaFlowNode, Edge>["onInit"]>;
  onNodeDragStop: NonNullable<ReactFlowProps<StelaFlowNode, Edge>["onNodeDragStop"]>;
}

function FlowViewport({
  className,
  nodes,
  edges,
  editing,
  saving,
  onNodesChange,
  onInit,
  onNodeDragStop,
}: FlowViewportProps) {
  return <div className={cn("overflow-hidden rounded-sm border bg-background", className)}>
    <ReactFlow<StelaFlowNode, Edge>
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onInit={onInit}
      onNodeDragStop={onNodeDragStop}
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
  </div>;
}

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
      tone: nodeTone(node),
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
  const [placedNodes, setPlacedNodes] = useState<FlowCard["nodes"]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const expandedInstanceRef = useRef<ReactFlowInstance<StelaFlowNode, Edge> | null>(null);
  const edges = useMemo(() => rendererEdges(card), [card]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void layoutFlowCard(card, true).then((placed) => {
      if (!active) return;
      setPlacedNodes(placed);
      setNodes(rendererNodes(card, placed, editing));
      setLoading(false);
      if (expanded) window.setTimeout(() => void expandedInstanceRef.current?.fitView({ padding: 0.12, duration: 250 }), 0);
    }).catch((reason: unknown) => {
      if (active) { setError(reason instanceof Error ? reason.message : String(reason)); setLoading(false); }
    });
    return () => { active = false; };
  }, [card, editing, setNodes]);

  useEffect(() => {
    if (!expanded) {
      expandedInstanceRef.current = null;
      return;
    }
    window.setTimeout(() => void expandedInstanceRef.current?.fitView({ padding: 0.12, duration: 250 }), 0);
  }, [expanded]);

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
      setPlacedNodes(placed);
      setNodes(rendererNodes({ ...card, direction }, placed, editing));
      await save({ direction, positions: placed.map((node) => ({ nodeId: node.id, position: node.position! })) });
      window.setTimeout(() => void expandedInstanceRef.current?.fitView({ padding: 0.12, duration: 250 }), 0);
    } finally { setLoading(false); }
  };

  const saveNodePosition: NonNullable<ReactFlowProps<StelaFlowNode, Edge>["onNodeDragStop"]> = (_event, node) => {
    setPlacedNodes((current) => current.map((item) => item.id === node.id ? { ...item, position: node.position } : item));
    void save({ positions: [{ nodeId: node.id, position: node.position }] });
  };

  const setExpandedOpen = (open: boolean) => {
    setExpanded(open);
    if (!open) setEditing(false);
  };

  if (loading && nodes.length === 0) return <div className="flex h-[440px] items-center justify-center rounded-lg border"><Loader2 className="h-4 w-4 animate-spin" /></div>;
  return <div className="space-y-1.5">
    <div className="flex items-center justify-end gap-1">
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="rounded-sm border p-1.5 text-muted-foreground hover:text-foreground"
        title={t("analysisCanvas.flowExpand")}
        aria-label={t("analysisCanvas.flowExpand")}
      >
        <Maximize2 className="h-3.5 w-3.5" />
      </button>
    </div>
    {error ? <div className="rounded bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div> : null}
    <ReadOnlyFlowPreview card={card} nodes={placedNodes} />
    <Dialog.Root open={expanded} onOpenChange={setExpandedOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[90] bg-black/45 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[91] flex h-[90vh] w-[96vw] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-border bg-background text-foreground shadow-2xl">
          <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
            <div className="min-w-0">
              <Dialog.Title className="truncate text-sm font-semibold">{card.title}</Dialog.Title>
              <Dialog.Description className="sr-only">{t("analysisCanvas.flowExpand")}</Dialog.Description>
            </div>
            <div className="flex items-center gap-1">
              {editing ? <>
                <button type="button" disabled={saving || loading} className="rounded-sm border p-1.5 text-muted-foreground hover:text-foreground" title={t("analysisCanvas.flowTopBottom")} onClick={() => void autoLayout("TB")}><ArrowDown className="h-3.5 w-3.5" /></button>
                <button type="button" disabled={saving || loading} className="rounded-sm border p-1.5 text-muted-foreground hover:text-foreground" title={t("analysisCanvas.flowLeftRight")} onClick={() => void autoLayout("LR")}><ArrowRight className="h-3.5 w-3.5" /></button>
                <button type="button" disabled={saving || loading} className="rounded-sm border p-1.5 text-muted-foreground hover:text-foreground" title={t("analysisCanvas.flowAutoLayout")} onClick={() => void autoLayout(card.direction)}>{saving || loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <WandSparkles className="h-3.5 w-3.5" />}</button>
              </> : null}
              <button
                type="button"
                role="switch"
                aria-checked={editing}
                disabled={saving || loading}
                onClick={() => setEditing((value) => !value)}
                className={cn("ml-1 inline-flex h-7 items-center gap-1.5 rounded-sm border px-2 text-[11px]", editing ? "border-primary/40 bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground")}
                title={t(editing ? "analysisCanvas.flowFinishLayout" : "analysisCanvas.flowEditLayout")}
              >
                {editing ? <Move className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}
                {t(editing ? "analysisCanvas.flowFinishLayout" : "analysisCanvas.flowEditLayout")}
              </button>
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="ml-1 rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                  title={t("settings.close")}
                  aria-label={t("settings.close")}
                >
                  <X className="h-4 w-4" />
                </button>
              </Dialog.Close>
            </div>
          </header>
          <FlowViewport
            className="min-h-0 flex-1 rounded-none border-0"
            nodes={nodes}
            edges={edges}
            editing={editing}
            saving={saving}
            onNodesChange={onNodesChange}
            onInit={(instance) => {
              expandedInstanceRef.current = instance;
              window.setTimeout(() => void instance.fitView({ padding: 0.12, duration: 250 }), 0);
            }}
            onNodeDragStop={saveNodePosition}
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  </div>;
}
