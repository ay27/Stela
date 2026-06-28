/**
 * Wiki link NodeView（v0.3 M1）。
 *
 * 渲染 `[[target]]` / `[[target|alias]]` 为可点击的 inline span：
 *   - mount 时异步探测候选文件是否存在 → resolved / missing
 *   - 点击：存在 → openFile + 可选 slug；不存在 → console.warn 并保留视觉提示
 *   - watcher 触发 cache 清空时由 ProseMirror 重新走 update（取决于上层是否 force-rerender，
 *     v0.3.0 暂时只在挂载时探测一次；M2 上线 INDEX_CHANGED 后会重做）
 *
 * 不同于 RunSQL 的复杂 NodeView，wiki link 无内嵌编辑器，DOM 是单层 span，光标
 * 由 ProseMirror 视为不可进入的 atom（schema 已声明）。
 */
import type { Node as ProseNode } from "@milkdown/prose/model";
import type { EditorView, NodeView } from "@milkdown/prose/view";

import { resolveWikiTarget } from "./wiki-resolver";
import { useWorkspace } from "@/state/workspace";

const ATTR_FLAG = "data-stela-wiki";
const ATTR_TARGET = "data-target";
const ATTR_ALIAS = "data-alias";
const ATTR_RESOLVED = "data-resolved";

export class WikiLinkNodeView implements NodeView {
  dom: HTMLElement;
  private node: ProseNode;
  private destroyed = false;
  /**
   * 宿主文档绝对路径——用于解析相对 wiki link `[[./foo]]` / `[[../bar]]`。
   * 来自 [src/editor/MilkdownEditor.tsx](../MilkdownEditor.tsx) 渲染时打在
   * `.stela-milkdown-host` 上的 `data-stela-note-path` 属性。读不到（脱离编辑
   * 器场景，比如未来嵌到预览里）时 fallback 到 vault 根，仍可解析非相对路径。
   */
  private readonly notePath: string | null;

  constructor(node: ProseNode, view: EditorView) {
    this.node = node;
    this.notePath = WikiLinkNodeView.findNotePath(view);
    this.dom = document.createElement("span");
    this.dom.setAttribute(ATTR_FLAG, "");
    this.dom.contentEditable = "false";
    this.dom.classList.add("stela-wiki");
    this.dom.addEventListener("click", this.onClick);
    this.dom.addEventListener("mousedown", this.onMouseDown);
    this.render();
    void this.probeResolution();
  }

  private static findNotePath(view: EditorView): string | null {
    const host = view.dom.closest<HTMLElement>("[data-stela-note-path]");
    return host?.getAttribute("data-stela-note-path") ?? null;
  }

  update(node: ProseNode): boolean {
    if (node.type.name !== this.node.type.name) return false;
    const targetChanged = node.attrs.target !== this.node.attrs.target;
    const aliasChanged = node.attrs.alias !== this.node.attrs.alias;
    this.node = node;
    this.render();
    if (targetChanged || aliasChanged) {
      void this.probeResolution();
    }
    return true;
  }

  destroy(): void {
    this.destroyed = true;
    this.dom.removeEventListener("click", this.onClick);
    this.dom.removeEventListener("mousedown", this.onMouseDown);
  }

  ignoreMutation(): boolean {
    // span 内文本由我们自行控制，PM 不必跟踪 DOM 变化。
    return true;
  }

  private render(): void {
    const target = (this.node.attrs.target as string) ?? "";
    const alias = (this.node.attrs.alias as string | null) ?? null;
    const resolved = (this.node.attrs.resolved as string) ?? "unknown";
    this.dom.setAttribute(ATTR_TARGET, target);
    if (alias) this.dom.setAttribute(ATTR_ALIAS, alias);
    else this.dom.removeAttribute(ATTR_ALIAS);
    this.dom.setAttribute(ATTR_RESOLVED, resolved);
    this.dom.className = `stela-wiki stela-wiki--${resolved}`;
    this.dom.title = alias && alias.length > 0
      ? `${alias} → ${target}`
      : target;
    const display = alias && alias.length > 0 ? alias : target;
    if (this.dom.textContent !== display) this.dom.textContent = display;
  }

  private async probeResolution(): Promise<void> {
    const target = (this.node.attrs.target as string)?.trim();
    if (!target) {
      this.applyResolutionAttr("missing");
      return;
    }
    const ws = useWorkspace.getState();
    if (!ws.vaultPath) return;
    try {
      const result = await resolveWikiTarget(
        ws.vaultPath,
        target,
        this.notePath,
      );
      if (this.destroyed) return;
      this.applyResolutionAttr(result?.exists ? "resolved" : "missing");
    } catch (err) {
      console.warn("[stela] wiki resolve failed", target, err);
      this.applyResolutionAttr("missing");
    }
  }

  private applyResolutionAttr(state: "resolved" | "missing" | "unknown"): void {
    if (this.destroyed) return;
    // 直接改 DOM 属性即可——schema 上的 `resolved` attr 仅在 toDOM 初值用，
    // 我们自管 NodeView 的视觉态，不必触发 PM transaction（避免误打 dirty）。
    this.dom.setAttribute(ATTR_RESOLVED, state);
    this.dom.classList.remove(
      "stela-wiki--unknown",
      "stela-wiki--resolved",
      "stela-wiki--missing",
    );
    this.dom.classList.add(`stela-wiki--${state}`);
  }

  private onMouseDown = (ev: MouseEvent): void => {
    // 阻止 PM 把 click 解读为 selection 变化，让 click 走我们自己的 handler。
    if (ev.button !== 0) return;
    ev.preventDefault();
  };

  private onClick = (ev: MouseEvent): void => {
    if (ev.button !== 0) return;
    if (ev.defaultPrevented) return;
    ev.preventDefault();
    ev.stopPropagation();
    void this.handleNavigate();
  };

  private async handleNavigate(): Promise<void> {
    const target = (this.node.attrs.target as string)?.trim();
    if (!target) return;
    const ws = useWorkspace.getState();
    if (!ws.vaultPath) return;
    const result = await resolveWikiTarget(
      ws.vaultPath,
      target,
      this.notePath,
    );
    if (!result) return;
    if (!result.exists) {
      console.warn("[stela] wiki link unresolved", target);
      return;
    }
    if (result.anchor) {
      ws.openFile(result.path, { scrollToSlug: result.anchor });
    } else {
      ws.openFile(result.path);
    }
  }
}
