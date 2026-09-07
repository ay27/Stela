import type { Ctx } from "@milkdown/kit/ctx";
import { block } from "@milkdown/kit/plugin/block";

/** Keep Crepe's add callback and native block drag provider on one target. */
export function configureCompactBlockHandle(ctx: Ctx): void {
  const spec = ctx.get(block.key);
  const createView = spec.view;
  if (!createView) return;

  ctx.set(block.key, {
    ...spec,
    view: (view) => {
      const original = createView(view);
      let cleanup: (() => void) | undefined;
      // BlockProvider appends its handle in its first animation frame.
      const frame = requestAnimationFrame(() => {
        const handle = view.dom.parentElement?.querySelector<HTMLElement>(
          ".milkdown-block-handle",
        );
        if (handle) cleanup = compactBlockHandle(handle);
      });
      return {
        update: (nextView, previousState) =>
          original.update?.(nextView, previousState),
        destroy: () => {
          cancelAnimationFrame(frame);
          cleanup?.();
          original.destroy?.();
        },
      };
    },
  });
}

function compactBlockHandle(handle: HTMLElement): () => void {
  const add = handle.querySelector<HTMLElement>(".operation-item");
  if (!add) return () => {};
  // Reuse Crepe's original grip artwork while retaining the add callback.
  const dragIcon = handle.querySelector(".operation-item:last-child svg");
  const addIcon = add.querySelector("svg");
  if (dragIcon && addIcon) addIcon.replaceWith(dragIcon.cloneNode(true));
  handle.classList.add("stela-compact-block-handle");
  add.classList.add("stela-block-action");
  let press: { id: number; x: number; y: number } | null = null;

  const reset = () => {
    press = null;
    add.classList.remove("active");
  };
  const onPointerDown = (event: PointerEvent) => {
    // Skip Crepe's pointerdown preventDefault: it suppresses the mousedown
    // used by BlockProvider and Stela's multi-block drag selection.
    event.stopImmediatePropagation();
    reset();
    if (event.button !== 0 || !event.isPrimary) return;
    press = { id: event.pointerId, x: event.clientX, y: event.clientY };
    add.classList.add("active");
  };
  const onPointerMove = (event: PointerEvent) => {
    if (!press || press.id !== event.pointerId) return;
    if (Math.hypot(event.clientX - press.x, event.clientY - press.y) >= 4) {
      reset();
    }
  };
  const onPointerUp = (event: PointerEvent) => {
    const activate = press?.id === event.pointerId && event.button === 0;
    reset();
    // A plain release reaches Crepe's original add handler. A drag, cancelled
    // press, or release that started elsewhere must never insert a paragraph.
    if (!activate) event.stopImmediatePropagation();
  };

  add.addEventListener("pointerdown", onPointerDown, true);
  add.addEventListener("pointerup", onPointerUp, true);
  window.addEventListener("pointermove", onPointerMove, true);
  window.addEventListener("pointerup", reset);
  window.addEventListener("pointercancel", reset, true);
  // Capture before BlockSelectionView can consume a multi-block dragstart.
  window.addEventListener("dragstart", reset, true);
  window.addEventListener("blur", reset);
  return () => {
    reset();
    add.removeEventListener("pointerdown", onPointerDown, true);
    add.removeEventListener("pointerup", onPointerUp, true);
    window.removeEventListener("pointermove", onPointerMove, true);
    window.removeEventListener("pointerup", reset);
    window.removeEventListener("pointercancel", reset, true);
    window.removeEventListener("dragstart", reset, true);
    window.removeEventListener("blur", reset);
  };
}
