/**
 * 侧栏拖拽手柄。
 *
 * 视觉上是宽 4px 的透明条，hover / drag 时右侧 1px 变成 primary 色；鼠标捕获走
 * pointer events（支持触控笔 / 触摸屏），通过 `setPointerCapture` 保证移出手柄
 * 区域后也继续收到 pointermove。
 *
 * 拖拽期间在 `<body>` 挂 `data-sidebar-resizing="true"`，让 [AppShell] 和全局样式
 * 能禁用 aside 的 width transition 并把光标锁成 ew-resize，避免快速拖动时光标
 * 脱离手柄区域就变回默认箭头。
 */

import { useCallback, useRef } from "react";

import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  useLayout,
} from "@/state/layout";

const BODY_RESIZING_ATTR = "data-sidebar-resizing";

export function SidebarResizer() {
  const width = useLayout((s) => s.sidebarWidth);
  const setWidth = useLayout((s) => s.setSidebarWidth);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // 只响应主键（左键 / 触摸 / 笔），右键/中键不触发
      if (e.button !== 0) return;
      e.preventDefault();
      startXRef.current = e.clientX;
      startWidthRef.current = width;
      e.currentTarget.setPointerCapture(e.pointerId);
      document.body.setAttribute(BODY_RESIZING_ATTR, "true");
    },
    [width],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
      const delta = e.clientX - startXRef.current;
      setWidth(startWidthRef.current + delta);
    },
    [setWidth],
  );

  const endDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    document.body.removeAttribute(BODY_RESIZING_ATTR);
  }, []);

  const onDoubleClick = useCallback(() => {
    setWidth(SIDEBAR_DEFAULT_WIDTH);
  }, [setWidth]);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="调整侧栏宽度"
      aria-valuenow={width}
      aria-valuemin={SIDEBAR_MIN_WIDTH}
      aria-valuemax={SIDEBAR_MAX_WIDTH}
      title="拖拽调整宽度 · 双击重置"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={onDoubleClick}
      className="group absolute right-0 top-0 z-10 h-full w-[5px] -translate-x-[2px] cursor-ew-resize touch-none select-none"
    >
      {/* 激活态视觉条：1px 宽，默认透明，hover / 拖拽时显示 */}
      <div className="pointer-events-none absolute right-[2px] top-0 h-full w-[1px] bg-transparent transition-colors duration-100 group-hover:bg-primary/60 group-active:bg-primary" />
    </div>
  );
}
