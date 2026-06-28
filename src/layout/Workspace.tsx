import { useWorkspace } from "@/state/workspace";
import { WelcomeView } from "@/views/WelcomeView";
import { EditorView } from "@/views/EditorView";
import { ErrorBoundary } from "@/components/ErrorBoundary";

/**
 * Editor 区域。
 *
 * - tabs 为空 → Welcome 空态（取代了原来的 "welcome 是常驻 tab" 模型）
 * - 激活 tab 是 file → 渲染 EditorView（使用 tab.id 作为 React key 触发 remount）
 * - 其它情况（找不到激活 tab）→ 兜底渲染 Welcome
 */
export function Workspace() {
  const tabs = useWorkspace((s) => s.tabs);
  const activeId = useWorkspace((s) => s.activeTabId);

  if (tabs.length === 0) {
    return <WelcomeView />;
  }

  const active = activeId ? tabs.find((t) => t.id === activeId) : undefined;
  if (active && active.kind === "file" && active.path) {
    return (
      <ErrorBoundary resetKey={active.id}>
        <EditorView key={active.id} tabId={active.id} path={active.path} />
      </ErrorBoundary>
    );
  }
  return <WelcomeView />;
}
