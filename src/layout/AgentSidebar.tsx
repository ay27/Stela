/**
 * 右侧全局 Agent 栏。
 *
 * 跟左侧 Sidebar（文件树/搜索，属于 vault 范畴）、编辑器内的文档目录
 * （DocumentTocRail，属于当前文档范畴）都不同——Agent 是应用级、跨文档的工具，
 * 所以单独占一栏，用边框 + 独立宽度状态把它跟文档区分开，强化"全局"的观感。
 *
 * 默认折叠（避免常驻占用太多屏幕宽度），可通过 Mod+Shift+A / TabBar 右侧图标 /
 * 面板内按钮 / 命令面板展开或收起，宽度可拖拽调整（持久化到 localStorage，逻辑与
 * 左侧 Sidebar 对称）。
 */

import { AgentPanel } from "@/components/ai/agent-panel";
import { useLayout } from "@/state/layout";
import { cn } from "@/lib/utils";

import { AgentPanelResizer } from "./AgentPanelResizer";

export function AgentSidebar() {
  const collapsed = useLayout((s) => s.agentPanelCollapsed);
  const width = useLayout((s) => s.agentPanelWidth);

  return (
    <aside
      data-agent-aside
      style={collapsed ? { width: 0 } : { width }}
      className={cn(
        "relative flex h-full flex-none flex-col border-l border-border bg-background text-foreground transition-[width] duration-150",
        collapsed && "overflow-hidden border-l-0",
      )}
    >
      {collapsed ? null : <AgentPanelResizer />}
      <AgentPanel />
    </aside>
  );
}
