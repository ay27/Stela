/**
 * Agent 全局栏拖拽手柄，挂在栏的左边缘。跟 [SidebarResizer](./SidebarResizer.tsx)
 * 同一套实现，只是拖拽方向相反（向左拖变宽，因为栏在屏幕右侧）。
 */

import { useCallback, useRef } from "react";

import {
  AGENT_PANEL_DEFAULT_WIDTH,
  AGENT_PANEL_MAX_WIDTH,
  AGENT_PANEL_MIN_WIDTH,
  useLayout,
} from "@/state/layout";

const BODY_RESIZING_ATTR = "data-sidebar-resizing";

export function AgentPanelResizer() {
  const width = useLayout((s) => s.agentPanelWidth);
  const setWidth = useLayout((s) => s.setAgentPanelWidth);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
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
      // 栏在右侧，往左拖（负 delta）应该变宽，符号跟左侧 SidebarResizer 相反。
      const delta = startXRef.current - e.clientX;
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
    setWidth(AGENT_PANEL_DEFAULT_WIDTH);
  }, [setWidth]);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="调整 Agent 栏宽度"
      aria-valuenow={width}
      aria-valuemin={AGENT_PANEL_MIN_WIDTH}
      aria-valuemax={AGENT_PANEL_MAX_WIDTH}
      title="拖拽调整宽度 · 双击重置"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={onDoubleClick}
      className="group absolute left-0 top-0 z-10 h-full w-[5px] -translate-x-1/2 cursor-ew-resize touch-none select-none"
    >
      <div className="pointer-events-none absolute left-[2px] top-0 h-full w-[1px] bg-transparent transition-colors duration-100 group-hover:bg-primary/60 group-active:bg-primary" />
    </div>
  );
}
