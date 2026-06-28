/**
 * 图片双击预览 overlay。
 *
 * 行为：
 *   - 监听 host 元素上的 `dblclick` 事件，命中编辑器内 `<img>` 时打开。
 *   - overlay 用 React Portal 挂到 `document.body`，避免被 host 的 stacking
 *     context / 滚动条裁掉。
 *   - 关闭：点击遮罩 / Esc / 点击右上角 X。
 *   - 显示：图片自适应视口；底部提示原始相对路径（取自 `<img alt>` 或 `src`）。
 *   - 缩放：鼠标滚轮 / 触控板捏合（macOS pinch → wheel + ctrlKey）/
 *     键盘 +/- / 工具栏 +/-/重置。鼠标位置作为缩放锚点，保持鼠标下的像素不动。
 *   - 平移：当 zoom > 1 时，按住左键拖动整张图；zoom = 1 时点遮罩仍然关闭。
 *
 * 不依赖 Milkdown ctx，纯 DOM event。这样同时覆盖：
 *   - 普通 `image` 节点（commonmark inline）
 *   - Crepe `image-block` Web Component 内嵌的 `<img>`
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface PreviewState {
  /** 真正塞给 `<img src>` 的 URL（已经过 proxyDomURL 处理，可能是 blob:） */
  displaySrc: string;
  /** 原始 markdown 里的 src（相对路径），用于底部提示 */
  rawSrc: string;
  /** alt 文本（如果有） */
  alt: string;
}

/** 缩放上下限——下界给 0.1 已经足够看清缩略，上界 10x 适配大多数像素级查看场景 */
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 10;
/** 普通滚轮：每次 deltaY 触发一档 1.15x 缩放，节奏接近浏览器原生 Cmd+加号 */
const WHEEL_STEP = 1.15;
/** 拖动判定阈值（px）：低于这个距离视为单击，避免拖一下点击同时触发关闭 */
const DRAG_THRESHOLD_PX = 3;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

interface ImagePreviewOverlayProps {
  /** 编辑器宿主元素 ref；overlay 监听它的 dblclick */
  hostRef: React.RefObject<HTMLElement | null>;
}

function readRawSrc(img: HTMLImageElement): string {
  // ProseMirror image NodeView 一般会把原 markdown src 写到 `data-src` /
  // `data-original-src` 上；Crepe image-inline 会写到 `data-original-src`。
  // 都没有时退回到 currentSrc。
  return (
    img.getAttribute("data-original-src") ||
    img.getAttribute("data-src") ||
    img.dataset.originalSrc ||
    img.dataset.src ||
    img.getAttribute("src") ||
    ""
  );
}

/**
 * 把 dblclick 事件的 target 解析回真正的 `<img>`。
 *
 * 三种命中路径，依次尝试：
 *   1. target 自己就是 `<img>`
 *   2. target 的祖先链上（closest）有 `<img>`——常见于点中 figure / wrapper
 *   3. target 自己（或其祖先）是 image-block / image-inline 的容器，向**下**
 *      在容器内 querySelector 一个 `<img>`。Crepe 的 image-block 用 Vue 在
 *      `<div class="milkdown-image-block">` 里渲染，用户双击容器边缘 / caption
 *      之外的空白时 e.target 会是容器本身，closest('img') 返回 null——这时
 *      要靠这条向下查找的兜底打开预览。
 */
function findClosestImg(target: EventTarget | null): HTMLImageElement | null {
  if (!(target instanceof Element)) return null;
  if (target instanceof HTMLImageElement) return target;
  const ancestorImg = target.closest("img");
  if (ancestorImg instanceof HTMLImageElement) return ancestorImg;
  const wrapper = target.closest(
    ".milkdown-image-block, .milkdown-inline-image, [data-type='image-block'], [data-type='image-inline']",
  );
  if (wrapper instanceof HTMLElement) {
    const inner = wrapper.querySelector("img");
    if (inner instanceof HTMLImageElement) return inner;
  }
  return null;
}

export function ImagePreviewOverlay({ hostRef }: ImagePreviewOverlayProps) {
  const [state, setState] = useState<PreviewState | null>(null);
  // zoom 单独 state 是为了让工具栏百分比 / cursor 类名能跟着变；x/y 走 ref +
  // 直接写 DOM transform，避免拖拽 / 缩放高频路径每次都 React re-render。
  const [zoom, setZoom] = useState(1);
  const overlayRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const transformRef = useRef({ zoom: 1, x: 0, y: 0 });
  /** 拖拽开始时的鼠标位置 + 当时的 transform，pointermove 期间累加用 */
  const dragRef = useRef<{
    startX: number;
    startY: number;
    baseX: number;
    baseY: number;
    /** 是否已超过阈值判定为「真拖动」——用于 click 关闭的兜底过滤 */
    moved: boolean;
  } | null>(null);

  const applyTransform = useCallback(() => {
    const img = imgRef.current;
    if (!img) return;
    const t = transformRef.current;
    img.style.transform = `translate(${t.x}px, ${t.y}px) scale(${t.zoom})`;
  }, []);

  const setTransform = useCallback(
    (next: { zoom?: number; x?: number; y?: number }) => {
      const cur = transformRef.current;
      const merged = {
        zoom: clamp(next.zoom ?? cur.zoom, MIN_ZOOM, MAX_ZOOM),
        x: next.x ?? cur.x,
        y: next.y ?? cur.y,
      };
      transformRef.current = merged;
      applyTransform();
      if (merged.zoom !== cur.zoom) setZoom(merged.zoom);
    },
    [applyTransform],
  );

  const close = useCallback(() => {
    setState(null);
    transformRef.current = { zoom: 1, x: 0, y: 0 };
    dragRef.current = null;
    setZoom(1);
  }, []);

  const reset = useCallback(() => {
    setTransform({ zoom: 1, x: 0, y: 0 });
  }, [setTransform]);

  useEffect(() => {
    // capture 阶段 + document 级监听：这样无论 ProseMirror NodeView / Vue
    // 包装组件 / Crepe 内部 plugin 在冒泡阶段是否 stopPropagation，我们都能
    // 第一时间拿到事件。过滤条件改为「target 必须落在某个 host 内」——
    // 这样即便编辑器内同页面有多个 host，也只响应自己这个 host。
    const onDblClick = (e: Event) => {
      const host = hostRef.current;
      if (!host) return;
      const target = e.target;
      if (!(target instanceof Node) || !host.contains(target)) return;
      const img = findClosestImg(target);
      if (!img) return;
      const src = img.currentSrc || img.src;
      if (!src) return;
      e.preventDefault();
      e.stopPropagation();
      // 打开时把 transform 复位，applyTransform 在 img 渲染后下面那个 effect 里跑
      transformRef.current = { zoom: 1, x: 0, y: 0 };
      setZoom(1);
      setState({
        displaySrc: src,
        rawSrc: readRawSrc(img),
        alt: img.alt || "",
      });
    };
    document.addEventListener("dblclick", onDblClick, { capture: true });
    return () => {
      document.removeEventListener("dblclick", onDblClick, {
        capture: true,
      } as EventListenerOptions);
    };
  }, [hostRef]);

  // 打开后第一次把 transform 写到 img 上（img 已经 mount）
  useEffect(() => {
    if (!state) return;
    applyTransform();
  }, [state, applyTransform]);

  // 键盘快捷键：Esc 关闭、+/- 缩放、0 / r 重置
  useEffect(() => {
    if (!state) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return;
      }
      if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        setTransform({ zoom: transformRef.current.zoom * WHEEL_STEP });
        return;
      }
      if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        setTransform({ zoom: transformRef.current.zoom / WHEEL_STEP });
        return;
      }
      if (e.key === "0" || e.key === "r" || e.key === "R") {
        e.preventDefault();
        reset();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [state, close, reset, setTransform]);

  // 鼠标滚轮 / 触控板捏合缩放。
  //
  //   - macOS 触控板 pinch 浏览器会合成成 `WheelEvent + ctrlKey: true`，
  //     deltaY 是连续小步长（典型 ±0.5～±5），用 exp(-dy * 0.01) 换算保证
  //     即使快速捏合也线性顺滑、不会一帧跳到极限。
  //   - 普通滚轮一次 wheel 带较大 deltaY（chrome 里 100），用固定倍数
  //     WHEEL_STEP 离散缩放，节奏与浏览器原生 Cmd+/Cmd- 一致。
  //   - 缩放锚点：鼠标在 img bbox 中心的偏移在缩放后保持视口位置不变——
  //     用户感觉是「以鼠标位置为中心放大」。
  //
  // 必须 non-passive 才能 preventDefault 阻断页面默认滚动 / 浏览器整体缩放，
  // React 的 onWheel 在某些环境下默认 passive，所以走原生 addEventListener。
  useEffect(() => {
    if (!state) return;
    const overlay = overlayRef.current;
    if (!overlay) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const cur = transformRef.current;
      const factor = e.ctrlKey
        ? Math.exp(-e.deltaY * 0.01)
        : e.deltaY < 0
          ? WHEEL_STEP
          : 1 / WHEEL_STEP;
      const nextZoom = clamp(cur.zoom * factor, MIN_ZOOM, MAX_ZOOM);
      if (nextZoom === cur.zoom) return;
      const img = imgRef.current;
      if (!img) {
        setTransform({ zoom: nextZoom });
        return;
      }
      const rect = img.getBoundingClientRect();
      // 鼠标相对 img 视觉中心的偏移（变换后坐标系）
      const offsetX = e.clientX - (rect.left + rect.width / 2);
      const offsetY = e.clientY - (rect.top + rect.height / 2);
      const ratio = nextZoom / cur.zoom;
      // 推导：transform-origin = center，新坐标下要让鼠标对应的图像点
      // 仍落在 (clientX, clientY) → newX = x - offsetX * (ratio - 1)
      const nextX = cur.x - offsetX * (ratio - 1);
      const nextY = cur.y - offsetY * (ratio - 1);
      setTransform({ zoom: nextZoom, x: nextX, y: nextY });
    };
    overlay.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      overlay.removeEventListener("wheel", onWheel);
    };
  }, [state, setTransform]);

  // pan：在 img 上 pointerdown 启动拖拽，pointermove / up 在 window 上监听，
  // 避免快速移动鼠标出 img bbox 后丢失事件。
  const onImgPointerDown = useCallback(
    (e: React.PointerEvent<HTMLImageElement>) => {
      // 仅响应主键（左键 / 触摸 / 主笔尖）；右键留给浏览器菜单
      if (e.button !== 0) return;
      e.preventDefault();
      const t = transformRef.current;
      dragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        baseX: t.x,
        baseY: t.y,
        moved: false,
      };
      const onMove = (ev: PointerEvent) => {
        const drag = dragRef.current;
        if (!drag) return;
        const dx = ev.clientX - drag.startX;
        const dy = ev.clientY - drag.startY;
        if (
          !drag.moved &&
          Math.hypot(dx, dy) < DRAG_THRESHOLD_PX
        ) {
          return;
        }
        drag.moved = true;
        setTransform({ x: drag.baseX + dx, y: drag.baseY + dy });
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        // 拖拽结束后保留 dragRef.moved 给同一帧 click 路径判断；下一帧再清
        const captured = dragRef.current;
        requestAnimationFrame(() => {
          if (dragRef.current === captured) dragRef.current = null;
        });
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [setTransform],
  );

  // overlay 背景点击关闭：拖拽过则忽略本次 click（避免拖一下松手即关）
  const onOverlayClick = useCallback(() => {
    if (dragRef.current?.moved) return;
    close();
  }, [close]);

  if (!state) return null;

  // 阻止 overlay 内 stage / 工具栏的 click / dblclick 冒泡回编辑器或触发关闭
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  const zoomPercent = Math.round(zoom * 100);
  const cursor =
    zoom > 1 ? (dragRef.current?.moved ? "grabbing" : "grab") : "zoom-in";

  return createPortal(
    <div
      ref={overlayRef}
      className="stela-image-preview"
      role="dialog"
      aria-modal="true"
      aria-label="图片预览"
      onClick={onOverlayClick}
    >
      <div
        className="stela-image-preview__toolbar"
        onClick={stop}
        onDoubleClick={stop}
      >
        <button
          type="button"
          className="stela-image-preview__tool-btn"
          aria-label="缩小"
          title="缩小（- 键 / 滚轮）"
          onClick={() =>
            setTransform({ zoom: transformRef.current.zoom / WHEEL_STEP })
          }
        >
          −
        </button>
        <button
          type="button"
          className="stela-image-preview__tool-zoom"
          aria-label="重置缩放"
          title="重置（0 键 / 双击图片）"
          onClick={reset}
        >
          {zoomPercent}%
        </button>
        <button
          type="button"
          className="stela-image-preview__tool-btn"
          aria-label="放大"
          title="放大（+ 键 / 滚轮）"
          onClick={() =>
            setTransform({ zoom: transformRef.current.zoom * WHEEL_STEP })
          }
        >
          +
        </button>
      </div>
      <button
        type="button"
        className="stela-image-preview__close"
        aria-label="关闭预览"
        onClick={(e) => {
          e.stopPropagation();
          close();
        }}
      >
        ×
      </button>
      <div
        className="stela-image-preview__stage"
        onClick={stop}
        onDoubleClick={stop}
      >
        <img
          ref={imgRef}
          className="stela-image-preview__img"
          src={state.displaySrc}
          alt={state.alt}
          draggable={false}
          onPointerDown={onImgPointerDown}
          onDoubleClick={(e) => {
            e.stopPropagation();
            reset();
          }}
          style={{ cursor }}
        />
        {state.rawSrc ? (
          <div
            className="stela-image-preview__caption"
            title={state.rawSrc}
            onClick={stop}
          >
            {state.alt ? `${state.alt} · ` : ""}
            {state.rawSrc}
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
