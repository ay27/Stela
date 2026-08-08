import assert from "node:assert/strict";

import { buildFlowScene, FLOW_NODE_MAX_WIDTH, FLOW_NODE_MIN_WIDTH, layoutFlowCard, measureFlowNode, type FlowCard } from "./flow-layout";

const base: FlowCard = {
  id: "pipeline",
  type: "flow",
  width: "full",
  direction: "TB",
  nodes: [
    { id: "source", kind: "source", label: "Source" },
    { id: "decision", kind: "decision", label: "Valid?" },
    { id: "result", kind: "result", label: "Result" },
  ],
  edges: [
    { id: "source_decision", source: "source", target: "decision" },
    { id: "decision_result", source: "decision", target: "result", label: "yes" },
  ],
};

const vertical = await layoutFlowCard(base, false);
assert.ok(vertical.every((node) => Number.isFinite(node.position?.x) && Number.isFinite(node.position?.y)));
assert.ok(vertical[0]!.position!.y < vertical[1]!.position!.y);
assert.ok(vertical[1]!.position!.y < vertical[2]!.position!.y);

const horizontal = await layoutFlowCard({ ...base, direction: "LR" }, false);
assert.ok(horizontal[0]!.position!.x < horizontal[1]!.position!.x);
assert.ok(horizontal[1]!.position!.x < horizontal[2]!.position!.x);
const scene = buildFlowScene({ ...base, direction: "LR" }, horizontal);
assert.ok(scene.width > scene.height);
assert.equal(scene.nodes.length, horizontal.length);
assert.equal(scene.edges.length, base.edges.length);
assert.ok(scene.nodes.every((node) => node.position.x >= 36 && node.position.y >= 36));
assert.match(scene.edges[0]!.path, /^M /);

const preserved = await layoutFlowCard({ ...base, nodes: [{ ...base.nodes[0]!, position: { x: 7, y: 9 } }, ...base.nodes.slice(1)] }, true);
assert.deepEqual(preserved[0]!.position, { x: 7, y: 9 });
assert.ok(preserved[1]!.position);

const shortSize = measureFlowNode(base.nodes[0]!);
const longSize = measureFlowNode({
  id: "long",
  kind: "step",
  label: "Validate the complete high-value candidate dataset before publishing the analytical result",
  description: "This description intentionally spans several lines so the node grows instead of truncating Agent-authored content.",
});
assert.ok(shortSize.width >= FLOW_NODE_MIN_WIDTH);
assert.ok(longSize.width <= FLOW_NODE_MAX_WIDTH);
assert.ok(longSize.width > shortSize.width || longSize.height > shortSize.height);

assert.deepEqual(buildFlowScene(base, []), { width: 0, height: 0, nodes: [], edges: [] });

console.log("flow-layout tests passed.");
