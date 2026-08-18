import type { Node as ProseNode, Slice } from "@milkdown/prose/model";
import {
  Plugin,
  PluginKey,
  Selection,
  type SelectionBookmark,
  type Transaction,
} from "@milkdown/prose/state";
import type { Mappable } from "@milkdown/prose/transform";
import {
  Decoration,
  DecorationSet,
  type EditorView,
} from "@milkdown/prose/view";
import { $prose } from "@milkdown/utils";

import { collapseAllRunsqlSelections } from "./runsql/codeblock-nodeview";

const BLOCK_RANGE_JSON_ID = "stela-block-range";
const RESTRICTED_CONTAINER_TYPES = new Set(["blockquote", "table"]);
const LIST_CONTAINER_TYPES = new Set(["bullet_list", "ordered_list"]);
const LIST_ITEM_TYPE = "list_item";
const AUTOSCROLL_EDGE_PX = 36;
const AUTOSCROLL_MAX_PX = 22;
const BLOCK_DRAG_THRESHOLD_PX = 5;
const SELECTION_OVERLAY_X_PX = 12;
const SELECTION_OVERLAY_Y_PX = 4;

export interface BlockSpan {
  from: number;
  to: number;
}

interface PendingBlockGesture {
  anchor: BlockSpan;
  startX: number;
  startY: number;
}

class BlockRangeBookmark implements SelectionBookmark {
  constructor(
    private readonly anchor: number,
    private readonly head: number,
  ) {}

  map(mapping: Mappable): SelectionBookmark {
    return new BlockRangeBookmark(
      mapping.map(this.anchor, this.anchor <= this.head ? 1 : -1),
      mapping.map(this.head, this.anchor <= this.head ? -1 : 1),
    );
  }

  resolve(doc: ProseNode): Selection {
    const anchor = clampPos(doc, this.anchor);
    const head = clampPos(doc, this.head);
    if (anchor === head) return Selection.near(doc.resolve(head));
    return new BlockRangeSelection(doc.resolve(anchor), doc.resolve(head));
  }
}

/**
 * A real ProseMirror selection whose endpoints sit on complete block
 * boundaries. ProseMirror only ships a single-node NodeSelection, so a custom
 * selection is needed for clipboard, deletion, history, and drag/drop to all
 * operate on the same multi-block range.
 */
export class BlockRangeSelection extends Selection {
  eq(other: Selection): boolean {
    return (
      other instanceof BlockRangeSelection &&
      other.anchor === this.anchor &&
      other.head === this.head
    );
  }

  map(doc: ProseNode, mapping: Mappable): Selection {
    const forward = this.anchor <= this.head;
    const mappedFrom = mapping.mapResult(this.from, 1);
    const mappedTo = mapping.mapResult(this.to, -1);
    const from = clampPos(doc, mappedFrom.pos);
    const to = clampPos(doc, mappedTo.pos);
    if (mappedFrom.deletedAcross || mappedTo.deletedAcross || from >= to) {
      return Selection.near(doc.resolve(Math.min(from, to)));
    }
    return new BlockRangeSelection(
      doc.resolve(forward ? from : to),
      doc.resolve(forward ? to : from),
    );
  }

  replace(tr: Transaction, content?: Slice): void {
    if (
      content === undefined &&
      this.from === 0 &&
      this.to === tr.doc.content.size
    ) {
      tr.delete(0, tr.doc.content.size);
      const selection = Selection.atStart(tr.doc);
      if (!selection.eq(tr.selection)) tr.setSelection(selection);
      return;
    }
    super.replace(tr, content);
  }

  toJSON(): { type: string; anchor: number; head: number } {
    return {
      type: BLOCK_RANGE_JSON_ID,
      anchor: this.anchor,
      head: this.head,
    };
  }

  static fromJSON(
    doc: ProseNode,
    json: { anchor?: unknown; head?: unknown },
  ): BlockRangeSelection {
    if (typeof json.anchor !== "number" || typeof json.head !== "number") {
      throw new RangeError("Invalid Stela block range selection");
    }
    return new BlockRangeSelection(
      doc.resolve(clampPos(doc, json.anchor)),
      doc.resolve(clampPos(doc, json.head)),
    );
  }

  getBookmark(): SelectionBookmark {
    return new BlockRangeBookmark(this.anchor, this.head);
  }
}

BlockRangeSelection.prototype.visible = false;

const registrationKey = "__stelaBlockRangeSelectionRegistered";
const registrationHost = globalThis as typeof globalThis & {
  [registrationKey]?: boolean;
};
if (!registrationHost[registrationKey]) {
  Selection.jsonID(BLOCK_RANGE_JSON_ID, BlockRangeSelection);
  registrationHost[registrationKey] = true;
}

function clampPos(doc: ProseNode, pos: number): number {
  return Math.max(0, Math.min(pos, doc.content.size));
}

function nodeSpanAtDepth(
  doc: ProseNode,
  pos: number,
  depth: number,
): (BlockSpan & { node: ProseNode; depth: number }) | null {
  const $pos = doc.resolve(clampPos(doc, pos));
  if (depth < 1 || depth > $pos.depth) return null;
  const node = $pos.node(depth);
  const from = $pos.before(depth);
  return { node, from, to: from + node.nodeSize, depth };
}

/**
 * Resolve a document position to the same visual block boundary used by the
 * Crepe handle: list items are selectable individually, while tables and
 * blockquotes collapse to their complete outer container.
 */
export function resolveBlockSpanAtPos(
  doc: ProseNode,
  rawPos: number,
): BlockSpan | null {
  const pos = clampPos(doc, rawPos);
  const $pos = doc.resolve(pos);
  const ancestors: Array<BlockSpan & { node: ProseNode; depth: number }> = [];
  for (let depth = 1; depth <= $pos.depth; depth += 1) {
    const span = nodeSpanAtDepth(doc, pos, depth);
    if (span) ancestors.push(span);
  }

  const restricted = ancestors.find((entry) =>
    RESTRICTED_CONTAINER_TYPES.has(entry.node.type.name),
  );
  if (restricted) return { from: restricted.from, to: restricted.to };

  const listItem = [...ancestors]
    .reverse()
    .find((entry) => entry.node.type.name === LIST_ITEM_TYPE);
  if (listItem) return { from: listItem.from, to: listItem.to };

  const directAfter = $pos.nodeAfter;
  if (directAfter?.isBlock) {
    return { from: pos, to: pos + directAfter.nodeSize };
  }

  const deepestBlock = [...ancestors]
    .reverse()
    .find((entry) => entry.node.isBlock);
  if (deepestBlock) {
    return { from: deepestBlock.from, to: deepestBlock.to };
  }

  const directBefore = $pos.nodeBefore;
  if (directBefore?.isBlock) {
    return { from: pos - directBefore.nodeSize, to: pos };
  }
  return null;
}

export function createBlockRangeSelection(
  doc: ProseNode,
  anchor: BlockSpan,
  head: BlockSpan,
): BlockRangeSelection {
  if (head.from >= anchor.from) {
    return new BlockRangeSelection(
      doc.resolve(anchor.from),
      doc.resolve(head.to),
    );
  }
  return new BlockRangeSelection(
    doc.resolve(anchor.to),
    doc.resolve(head.from),
  );
}

function isFullyInside(span: BlockSpan, from: number, to: number): boolean {
  return span.from >= from && span.to <= to;
}

/** Return the DOM nodes that delimit the whole-block selection. */
export function collectSelectedBlockSpans(
  doc: ProseNode,
  from: number,
  to: number,
): BlockSpan[] {
  const spans: BlockSpan[] = [];
  doc.descendants((node, pos, parent) => {
    const span = { from: pos, to: pos + node.nodeSize };
    if (span.to <= from || span.from >= to) return false;

    if (RESTRICTED_CONTAINER_TYPES.has(node.type.name)) {
      if (isFullyInside(span, from, to)) spans.push(span);
      return false;
    }

    if (node.type.name === LIST_ITEM_TYPE) {
      if (isFullyInside(span, from, to)) {
        spans.push(span);
        return false;
      }
      return true;
    }

    if (
      parent?.type.name === "doc" &&
      !LIST_CONTAINER_TYPES.has(node.type.name)
    ) {
      if (isFullyInside(span, from, to)) spans.push(span);
      return false;
    }
    return true;
  });
  return spans;
}

function decorationsForSelection(
  doc: ProseNode,
  selection: Selection,
): DecorationSet {
  if (!(selection instanceof BlockRangeSelection)) return DecorationSet.empty;
  const decorations = collectSelectedBlockSpans(
    doc,
    selection.from,
    selection.to,
  ).map((span) =>
    Decoration.node(span.from, span.to, {
      class: "stela-block-selected",
      "data-stela-block-selected": "true",
    }),
  );
  return DecorationSet.create(doc, decorations);
}

function eventElement(event: Event): Element | null {
  const target = event.target;
  if (target instanceof Element) return target;
  return target instanceof Node ? target.parentElement : null;
}

function isDragHandleTarget(target: Element | null): boolean {
  const item = target?.closest(".milkdown-block-handle .operation-item");
  if (!item) return false;
  return item.parentElement?.lastElementChild === item;
}

function spanContains(outer: BlockSpan, inner: BlockSpan): boolean {
  return inner.from >= outer.from && inner.to <= outer.to;
}

class BlockSelectionView {
  private readonly host: HTMLElement;
  private readonly overlayRoot: HTMLElement;
  private readonly overlay: HTMLDivElement;
  private readonly resizeObserver: ResizeObserver | null;
  private pendingGesture: PendingBlockGesture | null = null;
  private gestureAnchor: BlockSpan | null = null;
  private lastClientY = 0;
  private autoscrollFrame: number | null = null;
  private overlayFrame: number | null = null;
  private pendingRangeDrag = false;
  private activeRangeDrag = false;

  constructor(private readonly view: EditorView) {
    this.host =
      view.dom.closest<HTMLElement>(".stela-milkdown-host") ??
      view.dom.parentElement ??
      view.dom;
    this.overlayRoot = view.dom.parentElement ?? view.dom;
    this.overlay = document.createElement("div");
    this.overlay.className = "stela-block-selection-overlay";
    this.overlay.hidden = true;
    this.overlay.setAttribute("aria-hidden", "true");
    this.overlay.setAttribute("contenteditable", "false");
    this.overlayRoot.append(this.overlay);
    this.resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(this.scheduleOverlayUpdate);
    this.resizeObserver?.observe(view.dom);
    this.host.addEventListener("mousedown", this.onMouseDown, true);
    this.host.addEventListener("mouseup", this.onHostMouseUp, true);
    this.host.addEventListener("dragstart", this.onDragStart, true);
    this.host.addEventListener("dragend", this.onDragEnd, true);
    window.addEventListener("resize", this.scheduleOverlayUpdate);
    this.scheduleOverlayUpdate();
  }

  update(): void {
    this.scheduleOverlayUpdate();
  }

  destroy(): void {
    this.finishGesture();
    this.resizeObserver?.disconnect();
    this.host.removeEventListener("mousedown", this.onMouseDown, true);
    this.host.removeEventListener("mouseup", this.onHostMouseUp, true);
    this.host.removeEventListener("dragstart", this.onDragStart, true);
    this.host.removeEventListener("dragend", this.onDragEnd, true);
    window.removeEventListener("resize", this.scheduleOverlayUpdate);
    if (this.overlayFrame !== null) {
      cancelAnimationFrame(this.overlayFrame);
      this.overlayFrame = null;
    }
    this.overlay.remove();
    if (this.activeRangeDrag) this.clearRangeDrag();
  }

  private scheduleOverlayUpdate = (): void => {
    if (this.overlayFrame !== null) return;
    this.overlayFrame = requestAnimationFrame(() => {
      this.overlayFrame = null;
      this.updateOverlay();
    });
  };

  private updateOverlay(): void {
    const selection = this.view.state.selection;
    if (!(selection instanceof BlockRangeSelection)) {
      this.overlay.hidden = true;
      return;
    }

    const spans = collectSelectedBlockSpans(
      this.view.state.doc,
      selection.from,
      selection.to,
    );
    const first = spans[0];
    const last = spans.at(-1);
    if (!first || !last) {
      this.overlay.hidden = true;
      return;
    }

    const firstElement = this.nodeElement(first.from);
    const lastElement = this.nodeElement(last.from);
    if (!firstElement || !lastElement) {
      this.overlay.hidden = true;
      return;
    }

    const firstRect = firstElement.getBoundingClientRect();
    const lastRect = lastElement.getBoundingClientRect();
    const rootRect = this.overlayRoot.getBoundingClientRect();
    const bounds = this.contentBounds();
    const top = firstRect.top - rootRect.top - SELECTION_OVERLAY_Y_PX;
    const bottom = lastRect.bottom - rootRect.top + SELECTION_OVERLAY_Y_PX;

    this.overlay.style.left = `${bounds.left - rootRect.left - SELECTION_OVERLAY_X_PX}px`;
    this.overlay.style.top = `${top}px`;
    this.overlay.style.width = `${bounds.right - bounds.left + SELECTION_OVERLAY_X_PX * 2}px`;
    this.overlay.style.height = `${Math.max(0, bottom - top)}px`;
    this.overlay.hidden = false;
  }

  private nodeElement(pos: number): Element | null {
    const node = this.view.nodeDOM(pos);
    if (node instanceof Element) return node;
    return node instanceof Node ? node.parentElement : null;
  }

  private contentBounds(): { left: number; right: number } {
    const rect = this.view.dom.getBoundingClientRect();
    const style = getComputedStyle(this.view.dom);
    const paddingLeft = Number.parseFloat(style.paddingLeft) || 0;
    const paddingRight = Number.parseFloat(style.paddingRight) || 0;
    return {
      left: rect.left + paddingLeft,
      right: rect.right - paddingRight,
    };
  }

  private isInGutter(event: MouseEvent): boolean {
    const hostRect = this.host.getBoundingClientRect();
    if (
      event.clientX < hostRect.left ||
      event.clientX > hostRect.right ||
      event.clientY < hostRect.top ||
      event.clientY > hostRect.bottom
    ) {
      return false;
    }
    const bounds = this.contentBounds();
    return event.clientX < bounds.left || event.clientX > bounds.right;
  }

  private spanAtY(clientY: number): BlockSpan | null {
    const bounds = this.contentBounds();
    const x = Math.max(
      bounds.left + 1,
      Math.min(bounds.right - 1, (bounds.left + bounds.right) / 2),
    );
    const result = this.view.posAtCoords({ left: x, top: clientY });
    if (!result) return null;
    return resolveBlockSpanAtPos(
      this.view.state.doc,
      result.inside >= 0 ? result.inside : result.pos,
    );
  }

  private onMouseDown = (event: MouseEvent): void => {
    if (event.button !== 0 || !this.view.editable) return;
    const target = eventElement(event);

    if (isDragHandleTarget(target)) {
      const selection = this.view.state.selection;
      if (!(selection instanceof BlockRangeSelection)) return;
      const span = this.spanAtY(event.clientY);
      if (!span || !spanContains(selection, span)) return;
      this.pendingRangeDrag = true;
      event.stopPropagation();
      return;
    }

    if (!this.isInGutter(event)) {
      // A custom block selection still maps to a native DOM range. Without
      // collapsing it first, ProseMirror treats a mousedown anywhere inside
      // that range as the start of dragging the existing selection, so the
      // user cannot immediately switch back to normal text/CodeMirror
      // selection. Reset only the PM state and let the original event continue
      // untouched; PM or the NodeView then creates the precise inner selection.
      if (
        this.view.state.selection instanceof BlockRangeSelection &&
        target &&
        this.view.dom.contains(target)
      ) {
        const result = this.view.posAtCoords({
          left: event.clientX,
          top: event.clientY,
        });
        if (result) {
          this.view.dispatch(
            this.view.state.tr.setSelection(
              Selection.near(this.view.state.doc.resolve(result.pos)),
            ),
          );
        }
      }
      return;
    }
    if (target?.closest("[data-stela-block-selection-ignore]")) return;
    const span = this.spanAtY(event.clientY);
    if (!span) return;

    event.preventDefault();
    event.stopPropagation();
    this.pendingGesture = {
      anchor: span,
      startX: event.clientX,
      startY: event.clientY,
    };
    this.lastClientY = event.clientY;
    window.addEventListener("mousemove", this.onMouseMove, true);
    window.addEventListener("mouseup", this.onWindowMouseUp, true);
  };

  private onMouseMove = (event: MouseEvent): void => {
    if (!this.pendingGesture && !this.gestureAnchor) return;
    event.preventDefault();
    event.stopPropagation();
    this.lastClientY = event.clientY;

    if (!this.gestureAnchor) {
      const pending = this.pendingGesture;
      if (!pending) return;
      const distance = Math.hypot(
        event.clientX - pending.startX,
        event.clientY - pending.startY,
      );
      if (distance < BLOCK_DRAG_THRESHOLD_PX) return;

      this.pendingGesture = null;
      this.gestureAnchor = pending.anchor;
      this.host.dataset.stelaBlockSelecting = "true";
      collapseAllRunsqlSelections();
      window.getSelection()?.removeAllRanges();
      this.view.focus();
      this.view.dispatch(
        this.view.state.tr.setSelection(
          createBlockRangeSelection(
            this.view.state.doc,
            pending.anchor,
            pending.anchor,
          ),
        ),
      );
    }

    this.updateGestureSelection(event.clientY);
    this.ensureAutoscroll();
  };

  private updateGestureSelection(clientY: number): void {
    const anchor = this.gestureAnchor;
    if (!anchor) return;
    const hostRect = this.host.getBoundingClientRect();
    const y = Math.max(hostRect.top + 1, Math.min(hostRect.bottom - 1, clientY));
    const head = this.spanAtY(y);
    if (!head) return;
    const next = createBlockRangeSelection(this.view.state.doc, anchor, head);
    if (next.eq(this.view.state.selection)) return;
    this.view.dispatch(this.view.state.tr.setSelection(next));
  }

  private ensureAutoscroll(): void {
    if (this.autoscrollFrame !== null) return;
    const tick = () => {
      this.autoscrollFrame = null;
      if (!this.gestureAnchor) return;
      const rect = this.host.getBoundingClientRect();
      let delta = 0;
      if (this.lastClientY < rect.top + AUTOSCROLL_EDGE_PX) {
        delta = -Math.ceil(
          ((rect.top + AUTOSCROLL_EDGE_PX - this.lastClientY) /
            AUTOSCROLL_EDGE_PX) *
            AUTOSCROLL_MAX_PX,
        );
      } else if (this.lastClientY > rect.bottom - AUTOSCROLL_EDGE_PX) {
        delta = Math.ceil(
          ((this.lastClientY - (rect.bottom - AUTOSCROLL_EDGE_PX)) /
            AUTOSCROLL_EDGE_PX) *
            AUTOSCROLL_MAX_PX,
        );
      }
      if (delta === 0) return;
      const before = this.host.scrollTop;
      this.host.scrollTop += delta;
      if (this.host.scrollTop !== before) {
        this.updateGestureSelection(this.lastClientY);
        this.autoscrollFrame = requestAnimationFrame(tick);
      }
    };
    this.autoscrollFrame = requestAnimationFrame(tick);
  }

  private onWindowMouseUp = (event: MouseEvent): void => {
    if (!this.pendingGesture && !this.gestureAnchor) return;
    event.preventDefault();
    event.stopPropagation();
    this.finishGesture();
  };

  private finishGesture(): void {
    this.pendingGesture = null;
    this.gestureAnchor = null;
    delete this.host.dataset.stelaBlockSelecting;
    window.removeEventListener("mousemove", this.onMouseMove, true);
    window.removeEventListener("mouseup", this.onWindowMouseUp, true);
    if (this.autoscrollFrame !== null) {
      cancelAnimationFrame(this.autoscrollFrame);
      this.autoscrollFrame = null;
    }
  }

  private onHostMouseUp = (event: MouseEvent): void => {
    if (!this.pendingRangeDrag || this.activeRangeDrag) return;
    this.pendingRangeDrag = false;
    event.stopPropagation();
  };

  private onDragStart = (event: DragEvent): void => {
    if (!this.pendingRangeDrag || !event.dataTransfer) return;
    const selection = this.view.state.selection;
    if (!(selection instanceof BlockRangeSelection)) return;

    event.stopPropagation();
    const slice = selection.content();
    const serialized = this.view.serializeForClipboard(slice);
    event.dataTransfer.clearData();
    event.dataTransfer.effectAllowed = "copyMove";
    event.dataTransfer.setData("text/html", serialized.dom.innerHTML);
    event.dataTransfer.setData("text/plain", serialized.text);
    const first = collectSelectedBlockSpans(
      this.view.state.doc,
      selection.from,
      selection.to,
    )[0];
    const dragImage = first ? this.view.nodeDOM(first.from) : null;
    if (dragImage instanceof Element) {
      event.dataTransfer.setDragImage(dragImage, 0, 0);
    }
    this.view.dragging = { slice, move: true };
    this.view.dom.dataset.dragging = "true";
    this.pendingRangeDrag = false;
    this.activeRangeDrag = true;
  };

  private onDragEnd = (event: DragEvent): void => {
    if (!this.activeRangeDrag) return;
    event.stopPropagation();
    this.clearRangeDrag();
  };

  private clearRangeDrag(): void {
    this.pendingRangeDrag = false;
    this.activeRangeDrag = false;
    this.view.dragging = null;
    this.view.dom.dataset.dragging = "false";
  }
}

export const blockSelectionPluginKey = new PluginKey<DecorationSet>(
  "stela-block-selection",
);

function createBlockSelectionPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: blockSelectionPluginKey,
    state: {
      init: (_config, state) =>
        decorationsForSelection(state.doc, state.selection),
      apply: (tr, previous, _oldState, newState) => {
        if (!tr.docChanged && !tr.selectionSet) return previous;
        return decorationsForSelection(newState.doc, newState.selection);
      },
    },
    props: {
      decorations: (state) => blockSelectionPluginKey.getState(state) ?? null,
      handleKeyDown: (view, event) => {
        const selection = view.state.selection;
        if (!(selection instanceof BlockRangeSelection)) return false;
        let pos: number | null = null;
        let bias = 1;
        if (event.key === "Escape") {
          pos = selection.head;
          bias = selection.head >= selection.anchor ? -1 : 1;
        } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
          pos = selection.from;
          bias = 1;
        } else if (
          event.key === "ArrowRight" ||
          event.key === "ArrowDown"
        ) {
          pos = selection.to;
          bias = -1;
        }
        if (pos === null) return false;
        event.preventDefault();
        view.dispatch(
          view.state.tr.setSelection(
            Selection.near(view.state.doc.resolve(pos), bias),
          ),
        );
        return true;
      },
      handleTextInput: (view, _from, _to, text) => {
        if (!(view.state.selection instanceof BlockRangeSelection)) return false;
        const tr = view.state.tr.deleteSelection();
        if (text) tr.insertText(text);
        view.dispatch(tr.scrollIntoView());
        return true;
      },
    },
    view: (view) => new BlockSelectionView(view),
  });
}

export const blockSelectionPlugin = $prose(createBlockSelectionPlugin);
