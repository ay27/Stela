/**
 * 自定义 code_block NodeView。
 *
 *   - language === "runsql" → RunSQL UI（顶部数据库标签 + Run 按钮占位 + 内嵌 CM6 SQL
 *     编辑器 + 底部 detail 摘要条）
 *   - 其他 language → 极简代码块（顶部语言标签 + 内嵌 CM6 + 默认语法高亮）
 *
 * 我们替代 Crepe 自带的 CodeMirror 节点视图——Crepe 那一份是 Vue 实现的，与本工程的 React
 * 体系混用容易在 unmount 时漏管引用。这里全部用原生 DOM 直绘，NodeView 销毁就 destroy 掉
 * CM 实例，零额外框架依赖。
 *
 * forward/backward 同步逻辑参考 https://prosemirror.net/examples/codemirror/。
 */

import {
  EditorView as CMView,
  Decoration,
  WidgetType,
  keymap as cmKeymap,
  highlightActiveLine,
  lineNumbers,
  drawSelection,
} from "@codemirror/view";
import {
  EditorState as CMState,
  Compartment,
  Prec,
  type Extension,
  type Range,
} from "@codemirror/state";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { bracketMatching, indentOnInput } from "@codemirror/language";
import {
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from "@codemirror/autocomplete";
import type { Node as ProseNode } from "@milkdown/prose/model";
import type { EditorView as PMView, NodeView } from "@milkdown/prose/view";
import { TextSelection } from "@milkdown/prose/state";
import { exitCode } from "@milkdown/prose/commands";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import { sqlExtensions } from "./sql-language";
import { resolveEditorDialect } from "@/services/connectors/registry";
import { currentCmTheme, subscribeCmTheme } from "./cm-theme";
import { cmSearchHighlightExtension } from "./cm-search-highlight";
import { runBlock } from "./execution";
import { getRunContext, getRunNoteContext } from "./run-context";
import { showContextMenu, type MenuEntry } from "./context-menu";
import {
  BlockResult,
  DEFAULT_VIEW_STATE,
  type BlockResultViewState,
} from "@/components/block-result";
import type { ColumnDef } from "@/contracts";
import { ensureAutocompleteFor, peekAutocompleteFor } from "./fetch-schema";
import {
  mountTableMentionInput,
  type MountedTableMentionInputHandle,
} from "@/components/ai/mount-table-mention-input";
import { addRunsqlToChat, addSelectionToChat } from "@/components/ai/add-to-chat";
import { renderMarkdownIntoDom } from "./render-markdown-dom";
import { useColumnCache } from "./column-cache";
import { formatSqlCommand } from "./sql-format";
import { formatHotkey } from "@/lib/hotkeys";
import type { DetailMeta } from "@/core/types";
import { useWorkspace } from "@/state/workspace";
import { renderMermaid } from "@/editor/mermaid/render";
import { i18n } from "@/i18n";
import { isRunsqlBlockPending } from "./pending-runs";

export const RUNSQL_LANGUAGE = "runsql";
export const MERMAID_LANGUAGE = "mermaid";

const MERMAID_RENDER_DEBOUNCE_MS = 300;

type RunStateValue = "idle" | "running" | "error";

interface RunSqlAttrs {
  detail?: DetailMeta | null;
  blockId?: string;
  runState?: RunStateValue;
}

// Inline lucide icons（避免引 react-dom/server 渲染 SVG 拖一坨依赖进来）。
// 与 lucide-react 默认 stroke 1.75 / size 14|12 等价。
const DATABASE_ICON_HTML = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5"/><path d="M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3"/></svg>`;
const PLAY_ICON_HTML = `<svg class="stela-cb__run-glyph" xmlns="http://www.w3.org/2000/svg" width="9" height="9" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="7 4 20 12 7 20"/></svg>`;
const WORKFLOW_ICON_HTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="8" height="8" x="3" y="3" rx="2"/><path d="M7 11v4a2 2 0 0 0 2 2h4"/><rect width="8" height="8" x="13" y="13" rx="2"/></svg>`;
const EYE_ICON_HTML = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/></svg>`;
const CODE_ICON_HTML = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`;
// "wand-sparkles" 简化版：用于 runsql 顶栏的格式化按钮（与 lucide-react WandSparkles 视觉同款）
const FORMAT_ICON_HTML = `<svg class="stela-cb__format-glyph" xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72"/><path d="m14 7 3 3"/><path d="M5 6v4"/><path d="M19 14v4"/><path d="M10 2v2"/><path d="M7 8H3"/><path d="M21 16h-4"/><path d="M11 3H9"/></svg>`;
const AI_ICON_HTML = `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></svg>`;

type AiQuickEditMode = "rewrite" | "ask";

interface PendingAiRewrite {
  originalSql: string;
  proposedSql: string;
}

const activeRunsqlViews = new Set<CodeBlockNodeView>();

/** 全量重跑前把各 runsql CM 里未 focus 同步的 SQL 刷回 PM。 */
export function flushAllRunsqlEditors(): void {
  for (const view of activeRunsqlViews) {
    view.flushCmToPm();
  }
}

export class CodeBlockNodeView implements NodeView {
  dom: HTMLElement;
  private node: ProseNode;
  private readonly view: PMView;
  private readonly getPos: () => number | undefined;
  private cm!: CMView;
  private updating = false;
  private readonly languageCompartment = new Compartment();
  /** 主题（vscode-light / vscode-dark）的 Compartment，运行时切换 light/dark 不重建 CM。 */
  private readonly themeCompartment = new Compartment();
  private readonly aiDiffCompartment = new Compartment();
  /** subscribeCmTheme 的取消订阅；destroy 必须调，否则 listener 泄漏。 */
  private themeUnsub: (() => void) | null = null;
  private headerEl!: HTMLElement;
  private resultHostEl: HTMLElement | null = null;
  private resultRoot: Root | null = null;
  private aiComposerEl: HTMLElement | null = null;
  private aiMentionHandle: MountedTableMentionInputHandle | null = null;
  private aiReviewEl: HTMLElement | null = null;
  private pendingAiRewrite: PendingAiRewrite | null = null;
  private aiComposerGlobalCleanup: (() => void) | null = null;
  private resultExpanded = true;
  private lastErrorMessage: string | null = null;
  /** 仅 NodeView 内部递增；给 BlockResult 做强制重拉触发，不参与 markdown 序列化 */
  private refreshNonce = 0;
  /** 历史浏览 / 比对的纯 UI 态（不落 markdown），与 resultExpanded 同级 */
  private resultViewState: BlockResultViewState = DEFAULT_VIEW_STATE;
  /** 上次 render 见到的最新 runId；变化即说明有新执行，重置 view state */
  private lastSeenRunId: string | null = null;

  // ----- mermaid 相关 ------------------------------------------------------
  /** 仅 mermaid block：预览 SVG 挂载点 */
  private previewHostEl: HTMLElement | null = null;
  /** 仅 mermaid block：当前是否为预览态（源码态时 CM 可见、预览隐藏）。默认预览 */
  private previewMode = true;
  /** mermaid render 防抖：text 变化时合并 300ms 内多次渲染 */
  private mermaidDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * render 竞态令牌：每发起一次 renderMermaid 就 +1，回调里比对令牌，忽略过期结果。
   * 避免短时间连续改源码时旧的 promise 把新 SVG 覆盖掉。
   */
  private mermaidRenderToken = 0;
  /** mermaid 每个 NodeView 独占一个 id，避免 mermaid 内部对 id 做 document.querySelector 冲突 */
  private readonly mermaidId = `stela-mermaid-${
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2)
  }`;
  /** NodeView 是否已 destroy；destroy 后的异步 render 回调直接丢弃 */
  private destroyed = false;
  /**
   * 最近一次在 header / result-host / Radix Portal 上发生 pointer 交互的时间戳。
   * setSelection / selectNode 判断"是否应该把焦点抢回 CM"时用到：如果 300ms 内有过
   * 非 CM 区域的交互，就认为是用户在点外壳 UI（分页下拉 / 设置面板里的 Select /
   * 结果表按钮），这时抢焦点会关掉 Radix 菜单 + 拉动视口，必须忍住。
   */
  private lastNonCmInteractionAt = 0;

  constructor(node: ProseNode, view: PMView, getPos: () => number | undefined) {
    this.node = node;
    this.view = view;
    this.getPos = getPos;

    const isRunsql = node.attrs.language === RUNSQL_LANGUAGE;
    const isMermaid = node.attrs.language === MERMAID_LANGUAGE;

    this.dom = document.createElement("div");
    this.dom.className = isRunsql
      ? "stela-cb stela-cb--runsql"
      : isMermaid
        ? "stela-cb stela-cb--mermaid"
        : "stela-cb";
    if (isMermaid) this.dom.dataset.preview = this.previewMode ? "true" : "false";
    this.dom.addEventListener("contextmenu", this.onContextMenu);

    this.headerEl = document.createElement("div");
    this.headerEl.className = "stela-cb__header";
    // header / result-host 都不参与 PM 编辑选区。标记 contenteditable=false 可以：
    //   1) 避免 PM 把它们当作可编辑内容误派发 selection 事件
    //   2) 让内嵌的 Radix Select / button 的 focus 不会被 PM 抢回去
    this.headerEl.setAttribute("contenteditable", "false");
    // runsql 的 header 不再是占一整条的 bar，而是绝对定位到块右上角的紧凑动作组
    // （Format/Run，见 .stela-cb--runsql .stela-cb__header CSS）；DOM 顺序无所谓，
    // 放最前即可。mermaid / 普通代码块仍是顶部常规 header bar。
    this.dom.appendChild(this.headerEl);

    const cmHost = document.createElement("div");
    cmHost.className = "stela-cb__cm";
    this.dom.appendChild(cmHost);

    this.cm = new CMView({
      state: CMState.create({
        doc: node.textContent,
        extensions: this.buildBaseExtensions(node.attrs.language as string),
      }),
      parent: cmHost,
    });

    this.renderHeader(node);

    if (isRunsql) {
      activeRunsqlViews.add(this);
      this.resultHostEl = document.createElement("div");
      this.resultHostEl.className = "stela-cb__result-host";
      this.resultHostEl.setAttribute("contenteditable", "false");
      this.dom.appendChild(this.resultHostEl);
      this.resultRoot = createRoot(this.resultHostEl);
      this.renderResult(node);
      this.installShield(this.resultHostEl);
    }
    if (isMermaid) {
      this.ensurePreviewHost();
      this.scheduleMermaidRender(node.textContent, /*immediate*/ true);
    }
    this.installShield(this.headerEl);

    // 订阅主题切换：运行时切 light/dark 时 reconfigure compartment 即可，无需重建 CM。
    this.themeUnsub = subscribeCmTheme(() => {
      if (this.destroyed) return;
      this.cm.dispatch({
        effects: this.themeCompartment.reconfigure(currentCmTheme()),
      });
    });
  }

  // ----- ProseMirror NodeView API ------------------------------------------

  update(node: ProseNode): boolean {
    if (node.type !== this.node.type) return false;
    const prevLang = this.node.attrs.language;
    this.node = node;
    if (this.updating) return true;

    if (prevLang !== node.attrs.language) {
      this.cm.dispatch({
        effects: this.languageCompartment.reconfigure(
          this.languageExtension(node.attrs.language as string),
        ),
      });
      this.dom.classList.toggle(
        "stela-cb--runsql",
        node.attrs.language === RUNSQL_LANGUAGE,
      );
      this.dom.classList.toggle(
        "stela-cb--mermaid",
        node.attrs.language === MERMAID_LANGUAGE,
      );
      if (node.attrs.language === MERMAID_LANGUAGE) {
        this.dom.dataset.preview = this.previewMode ? "true" : "false";
      } else {
        delete this.dom.dataset.preview;
      }
    }

    this.renderHeader(node);
    if (node.attrs.language === RUNSQL_LANGUAGE) {
      if (!this.resultHostEl) {
        this.resultHostEl = document.createElement("div");
        this.resultHostEl.className = "stela-cb__result-host";
        this.resultHostEl.setAttribute("contenteditable", "false");
        this.dom.appendChild(this.resultHostEl);
        this.resultRoot = createRoot(this.resultHostEl);
        this.installShield(this.resultHostEl);
      }
      this.renderResult(node);
    } else if (this.resultHostEl) {
      this.resultRoot?.unmount();
      this.resultRoot = null;
      this.resultHostEl.remove();
      this.resultHostEl = null;
    }

    if (node.attrs.language === MERMAID_LANGUAGE) {
      this.ensurePreviewHost();
      // 源码态切 language 进来不需要渲染（只等切回 preview 时再渲染）；
      // 进入 mermaid 时如果在预览态，用 node.textContent 防抖渲染一次
      if (this.previewMode) this.scheduleMermaidRender(node.textContent);
    } else if (this.previewHostEl) {
      this.teardownPreviewHost();
    }

    const newText = node.textContent;
    const curText = this.cm.state.doc.toString();
    if (newText !== curText && !this.pendingAiRewrite) {
      let start = 0;
      let curEnd = curText.length;
      let newEnd = newText.length;
      while (
        start < curEnd &&
        start < newEnd &&
        curText.charCodeAt(start) === newText.charCodeAt(start)
      ) {
        ++start;
      }
      while (
        curEnd > start &&
        newEnd > start &&
        curText.charCodeAt(curEnd - 1) === newText.charCodeAt(newEnd - 1)
      ) {
        --curEnd;
        --newEnd;
      }
      this.updating = true;
      this.cm.dispatch({
        changes: { from: start, to: curEnd, insert: newText.slice(start, newEnd) },
      });
      this.updating = false;
    }

    // 文本改动后刷新 mermaid 预览：无论变更来自 CM forwardUpdate 还是外部 PM
    // 事务，这里统一防抖后重渲染（300ms 内连续改源码只渲一次，避免 CPU 占用）。
    if (node.attrs.language === MERMAID_LANGUAGE && this.previewMode) {
      this.scheduleMermaidRender(newText);
    }
    return true;
  }

  setSelection(anchor: number, head: number) {
    // 关键：不能无脑 cm.focus()。用户点分页下拉 / 设置里的 Select / header 按钮 /
    // 结果表复制按钮时：
    //   1. 浏览器会在 contenteditable 根上移动原生 caret
    //   2. PM 的 selectionchange 监听同步到 PM state
    //   3. PM 回调我们这个 setSelection
    // 如果这时硬 cm.focus()，会把 DOM selection 拽回 CM，触发 CM 的
    // scrollCursorIntoView 把视口拉回 CM cursor 所在行（通常是代码块顶部），
    // 肉眼看到的就是"点一下页面上滚半屏"，同时 Radix 菜单失焦瞬间关闭。
    if (this.shouldStealFocus()) {
      this.cm.focus();
    }
    this.updating = true;
    this.cm.dispatch({ selection: { anchor, head } });
    this.updating = false;
  }

  selectNode() {
    if (this.shouldStealFocus()) {
      this.cm.focus();
    }
  }

  /**
   * 判断是否应该把焦点从当前 activeElement 抢回 CM。核心规则：
   *   - 最近 300ms 内如果有过"非 CM 区域"的 pointer 交互（分页下拉 / 设置面板
   *     Select / 结果表按钮 / Radix Portal 菜单里点选项），一律不抢焦点。
   *
   * 为什么 activeElement 检查不够：Radix Select 的 Trigger 默认会
   * preventDefault 掉 pointerdown 的 focus 转移——点击瞬间 activeElement 常常
   * 还是 body 或之前聚焦的 CM，用 activeElement 判断会误判成"焦点在 CM 上，
   * 可以抢"，结果还是把视口拽回去。时间戳判断把"用户意图"固化下来，
   * PM 同步 selectionchange 时能正确地忍住 focus。
   */
  private isAiComposerFocused(): boolean {
    if (!this.aiComposerEl) return false;
    const active = document.activeElement;
    if (!active) return false;
    if (this.aiComposerEl.contains(active)) return true;
    if (active instanceof Element && active.closest("[data-mentions-portal]")) {
      return true;
    }
    return false;
  }

  private shouldStealFocus(): boolean {
    if (this.isAiComposerFocused()) return false;
    if (Date.now() - this.lastNonCmInteractionAt < 300) return false;
    return true;
  }

  /**
   * 给 header / result-host 挂事件屏蔽：
   *   1. bubble 阶段 stopPropagation，阻止冒到 PM view.dom 的 mousedown 根监听
   *      （配合 stopEvent()，让 PM 不会把这些点击算成 NodeSelection）
   *   2. 同时打时间戳，用于 setSelection/selectNode 判断是否抢焦点
   *
   * 注意不能用 capture 阶段：capture 下 stopPropagation 会一起把 target 阶段
   * 的 React / Radix 事件也干掉，Radix Select 连开都开不出来。
   */
  private installShield(el: HTMLElement): void {
    const types: (keyof HTMLElementEventMap)[] = [
      "mousedown",
      "mouseup",
      "click",
      "pointerdown",
      "pointerup",
    ];
    const handler = (ev: Event) => {
      const target = ev.target as Node | null;
      const editable =
        target instanceof Element &&
        (target.closest(".stela-table-mention") !== null ||
          target.closest("[data-mentions-portal]") !== null);
      this.lastNonCmInteractionAt = Date.now();
      if (editable) return;
      ev.stopPropagation();
    };
    for (const t of types) {
      el.addEventListener(t, handler);
    }
  }


  stopEvent(event: Event): boolean {
    // 任何 drag 生命周期事件都让 PM / block-plugin 接管：drop 事件的 target 命中
    // CM / header / 结果区 / mermaid 预览时，如果这里返回 true，PM 的
    // `eventBelongsToView` 会在走到 view.dom 前就短路 → editHandlers.drop 永远
    // 不触发，block 落不下去。
    //
    // 真正"block 原地不动"的首恶其实是 Tauri 的 dragDropEnabled（默认 true，OS
    // 层就把 drop 事件吃了），需要在 tauri.conf.json 里关掉；这里是"如果 drop
    // 能打到 webview，也别被我们拦掉"的兜底。
    if (event.type.startsWith("drag") || event.type === "drop") return false;

    // CM 内部事件 / header 按钮 / 结果表交互（折叠 / 滚动 / 行 hover）/ mermaid
    // 预览区的点击都由各自 handler 处理，PM 不要插手（否则点击会被解读为节点选择，
    // 触发 selection 跳变）。
    const target = event.target as Node | null;
    if (!target) return false;
    if (this.cm.dom.contains(target)) return true;
    if (this.headerEl.contains(target)) return true;
    if (this.aiComposerEl && this.aiComposerEl.contains(target)) return true;
    if (this.aiReviewEl && this.aiReviewEl.contains(target)) return true;
    if (this.resultHostEl && this.resultHostEl.contains(target)) return true;
    if (this.previewHostEl && this.previewHostEl.contains(target)) return true;
    return false;
  }

  ignoreMutation(): boolean {
    return true;
  }

  destroy() {
    this.destroyed = true;
    activeRunsqlViews.delete(this);
    this.dom.removeEventListener("contextmenu", this.onContextMenu);
    this.closeAiComposer();
    this.clearAiRewritePreview();
    if (this.themeUnsub) {
      this.themeUnsub();
      this.themeUnsub = null;
    }
    this.cm.destroy();
    if (this.resultRoot) {
      // queueMicrotask 包一层避免在 ProseMirror update 内部同步 unmount 触发 React warn
      const root = this.resultRoot;
      this.resultRoot = null;
      queueMicrotask(() => root.unmount());
    }
    if (this.mermaidDebounceTimer) {
      clearTimeout(this.mermaidDebounceTimer);
      this.mermaidDebounceTimer = null;
    }
    if (this.previewHostEl) {
      this.previewHostEl.remove();
      this.previewHostEl = null;
    }
    this.aiReviewEl?.remove();
    this.aiReviewEl = null;
  }

  // ----- 内部：CM 扩展 ------------------------------------------------------

  private buildBaseExtensions(language: string) {
    return [
      lineNumbers(),
      highlightActiveLine(),
      drawSelection(),
      history(),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      // VS Code Light / Dark 主题（@fsegurai/codemirror-theme-vscode-*）。
      // 自带 HighlightStyle，所以这里不再叠加 defaultHighlightStyle。
      // 用 Compartment 包裹是为了运行时切换 light/dark 时仅 reconfigure 不重建 CM。
      this.themeCompartment.of(currentCmTheme()),
      // 只有 Mod-Enter / Mod-r 这俩需要压过 defaultKeymap：defaultKeymap 里 Mod-Enter
      // 绑成了 insertBlankLine，如果不抢到最高优先级，runsql 的 Cmd+Enter 就变成插空行。
      // 方向键（ArrowUp/Down/Left/Right）留在默认优先级 + 排在 completionKeymap 之后，
      // 这样补全弹窗弹出时 completionKeymap 会先拦截（上下选候选、左右不影响），
      // 补全关闭时 bridgeKeymap 里的 maybeEscape 才会生效（光标在块边界才跳出）。
      Prec.highest(cmKeymap.of(this.bridgeKeymapHigh())),
      cmKeymap.of([
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...historyKeymap,
        ...completionKeymap,
        indentWithTab,
        ...this.bridgeKeymapLow(),
      ]),
      this.languageCompartment.of(this.languageExtension(language)),
      this.aiDiffCompartment.of([]),
      CMView.updateListener.of((update) => {
        if (this.updating) return;
        if (update.docChanged) this.forwardUpdate(update);
      }),
      // 搜索高亮：监听 setCmSearchHighlight / clearCmSearchHighlight effect，
      // 由 [src/editor/MilkdownEditor.tsx](../MilkdownEditor.tsx) reveal effect
      // 桥接（PM Decoration 在 NodeView 接管的 code_block 内无 DOM 可挂，必须走
      // CM 自家的 Decoration）。
      cmSearchHighlightExtension(),
      // 颜色 / 选区 / cursor / gutter 等交给 vscode 主题；字体族在 CMView.theme
      // 与 .stela-cb__cm CSS 里显式绑 :root --font-mono。
      CMView.theme({
        "&": {
          fontSize: "12.5px",
          fontFamily: "var(--font-mono)",
        },
        ".cm-scroller": {
          fontSize: "12.5px",
          fontFamily: "var(--font-mono)",
        },
        ".cm-content": {
          padding: "8px 0",
          fontFamily: "var(--font-mono)",
          // lineHeight: "1.45",
        },
        ".cm-gutters": {
          fontFamily: "var(--font-mono)",
        },
      }),
    ];
  }

  private languageExtension(language: string) {
    if (language === RUNSQL_LANGUAGE || language === "sql") {
      return [
        sqlExtensions({
          getSiblingSqls: () => this.collectSiblingSqls(),
          getTableNames: () => this.fetchTableNames(),
          ensureColumnsForTable: (db, table) =>
            this.ensureColumnsFor(db, table),
          dialect: resolveEditorDialect(getRunContext()?.connectionName),
        }),
        // 长行自动折行：嵌在 markdown 正文里的 SQL 块宽度受限，长 SELECT /
        // 长字符串不 wrap 就会出横向滚动条，既丑又把行号 gutter 推走。放在
        // languageExtension 里走 languageCompartment，这样语言改成普通 code
        // 时能跟着 reconfigure 掉，行为与 sqlExtensions 一致。
        CMView.lineWrapping,
      ];
    }
    return [];
  }

  /**
   * 遍历当前 PM doc，把所有 runsql code_block 的文本收集起来，排除当前节点自身。
   * 用于 SQL word-based 补全：用户通常会在多个 block 里复用列名 / 别名。
   */
  private collectSiblingSqls(): string[] {
    const selfPos = this.getPos();
    const out: string[] = [];
    this.view.state.doc.descendants((n, pos) => {
      if (n.type.name !== "code_block") return;
      if (n.attrs.language !== RUNSQL_LANGUAGE) return;
      if (selfPos !== undefined && pos === selfPos) return;
      const text = n.textContent.trim();
      if (text) out.push(text);
    });
    return out;
  }

  /**
   * 拉当前 connection 的表名列表；无连接直接返回 []（补全降级为仅关键字 +
   * sibling）。真实 fetch 逻辑和 TTL 缓存都在 `./fetch-schema.ts`，这里只做"找
   * 出当前文件的 connectionName"这一步。
   */
  private async fetchTableNames(): Promise<string[]> {
    const ctx = getRunContext();
    if (!ctx?.connectionName) return [];
    return ensureAutocompleteFor(ctx.connectionName);
  }

  /**
   * 拉指定表的列元数据，给 sql-language 的列上下文补全用。
   *   - 无连接：直接 []（补全 source 自然降级回顶层表名 / 关键字分支）
   *   - 走 column-cache，TTL 命中即时返回；首次 miss 时 await `LIMIT 0` 探针
   */
  private async ensureColumnsFor(
    db: string | null,
    table: string,
  ): Promise<ColumnDef[]> {
    const ctx = getRunContext();
    if (!ctx?.connectionName) return [];
    const tableNames = peekAutocompleteFor(ctx.connectionName);
    if (tableNames.length > 0 && !isKnownTable(tableNames, db, table)) {
      return [];
    }
    return useColumnCache.getState().ensure(ctx.connectionName, db, table);
  }

  /** 需要抢在 defaultKeymap 之前命中的全局快捷键（runsql 强语义，不能被普通编辑覆盖） */
  private bridgeKeymapHigh() {
    return [
      {
        key: "Mod-Enter",
        run: () => {
          // runsql block：Mod+Enter 触发执行（等价点 Run 按钮）；
          // 其他 language：保持 exitCode 原语义（跳出代码块开新段落）。
          if (this.node.attrs.language === RUNSQL_LANGUAGE) {
            this.triggerRun();
            return true;
          }
          if (
            !exitCode(this.view.state, this.view.dispatch.bind(this.view))
          )
            return false;
          this.view.focus();
          return true;
        },
      },
      {
        key: "Mod-r",
        run: () => {
          // 仅在 runsql 块内生效；重拉当前 runId 的结果（不重新执行 SQL）
          if (this.node.attrs.language !== RUNSQL_LANGUAGE) return false;
          this.refreshResult();
          return true;
        },
      },
      {
        key: "Mod-i",
        run: () => {
          if (this.node.attrs.language !== RUNSQL_LANGUAGE) return false;
          this.addCurrentSqlToChat();
          return true;
        },
      },
      {
        // SQL 格式化（v0.2 #3）：仅 runsql 块。其它语言代码块（含 mermaid）不做
        // 格式化——避免把 mermaid 源码或随手写的 plain code 也给改了。
        // 快捷键沿用 JetBrains 系列肌肉记忆：macOS ⌥⌘L、Win/Linux Ctrl+Alt+L。
        key: "Mod-Alt-l",
        run: (cm: CMView) => {
          if (this.node.attrs.language !== RUNSQL_LANGUAGE) return false;
          return formatSqlCommand(cm);
        },
      },
    ];
  }

  /**
   * 方向键 "跳出代码块" 兜底：光标在块首/末按 ArrowUp/Down/Left/Right 时回跳到外层
   * PM 段落。**必须**排在 completionKeymap 之后、默认优先级，否则补全弹窗开着时
   * 上下键会被 maybeEscape 吃掉，光标直接跳出 CM。
   */
  private bridgeKeymapLow() {
    return [
      {
        key: "ArrowUp",
        run: (cm: CMView) => this.maybeEscape("line", -1, cm),
      },
      {
        key: "ArrowLeft",
        run: (cm: CMView) => this.maybeEscape("char", -1, cm),
      },
      {
        key: "ArrowDown",
        run: (cm: CMView) => this.maybeEscape("line", 1, cm),
      },
      {
        key: "ArrowRight",
        run: (cm: CMView) => this.maybeEscape("char", 1, cm),
      },
    ];
  }

  // ----- 双向同步 -----------------------------------------------------------

  /** 无视 focus 状态，把 CM 全文写回 PM（全量重跑前调用）。 */
  flushCmToPm(): void {
    if (this.destroyed) return;
    if ((this.node.attrs.language as string) !== RUNSQL_LANGUAGE) return;
    if (this.pendingAiRewrite) return;
    const pos = this.getPos();
    if (pos === undefined) return;

    const cmText = this.cm.state.doc.toString();
    const pmNode = this.view.state.doc.nodeAt(pos);
    if (!pmNode) return;
    if (cmText === pmNode.textContent) return;

    const start = pos + 1;
    const end = pos + pmNode.nodeSize - 1;
    const content = cmText
      ? [this.view.state.schema.text(cmText)]
      : [];
    this.updating = true;
    this.view.dispatch(this.view.state.tr.replaceWith(start, end, content));
    this.updating = false;
  }

  private replaceSql(sql: string): void {
    const pos = this.getPos();
    if (pos === undefined) return;
    const pmNode = this.view.state.doc.nodeAt(pos);
    if (!pmNode) return;
    const start = pos + 1;
    const end = pos + pmNode.nodeSize - 1;
    const content = sql ? [this.view.state.schema.text(sql)] : [];
    this.updating = true;
    this.cm.dispatch({
      changes: { from: 0, to: this.cm.state.doc.length, insert: sql },
    });
    this.view.dispatch(this.view.state.tr.replaceWith(start, end, content));
    this.updating = false;
  }

  private previewAiRewrite(originalSql: string, proposedSql: string): void {
    this.pendingAiRewrite = { originalSql, proposedSql };
    this.updating = true;
    this.cm.dispatch({
      changes: { from: 0, to: this.cm.state.doc.length, insert: proposedSql },
      effects: this.aiDiffCompartment.reconfigure(
        buildAiRewriteDiffExtension(originalSql, proposedSql),
      ),
    });
    this.updating = false;
  }

  private acceptAiRewrite(): void {
    const pending = this.pendingAiRewrite;
    if (!pending) return;
    const proposedSql = pending.proposedSql;
    this.pendingAiRewrite = null;
    this.cm.dispatch({
      effects: this.aiDiffCompartment.reconfigure([]),
    });
    this.replaceSql(proposedSql);
    this.closeAiReview();
  }

  private discardAiRewrite(): void {
    const pending = this.pendingAiRewrite;
    if (!pending) return;
    this.pendingAiRewrite = null;
    this.updating = true;
    this.cm.dispatch({
      changes: {
        from: 0,
        to: this.cm.state.doc.length,
        insert: pending.originalSql,
      },
      effects: this.aiDiffCompartment.reconfigure([]),
    });
    this.updating = false;
    this.closeAiReview();
  }

  private clearAiRewritePreview(): void {
    if (!this.pendingAiRewrite) return;
    this.pendingAiRewrite = null;
    this.cm.dispatch({
      effects: this.aiDiffCompartment.reconfigure([]),
    });
  }

  private selectedSqlText(): string {
    const { main } = this.cm.state.selection;
    if (main.empty) return "";
    return this.cm.state.doc.sliceString(main.from, main.to);
  }

  private addCurrentSqlToChat(): void {
    const selectedText = this.selectedSqlText();
    if (selectedText.trim()) {
      addSelectionToChat(selectedText, "RunSQL selection");
      return;
    }
    addRunsqlToChat(this.node.textContent, "RunSQL block");
  }

  private insertAiAuxElement(el: HTMLElement): void {
    const anchor = this.resultHostEl ?? null;
    this.dom.insertBefore(el, anchor);
    this.installShield(el);
  }

  private insertAiFloatingReview(el: HTMLElement): void {
    document.body.appendChild(el);
    this.installShield(el);
    this.positionAiFloatingReview(el);
  }

  private positionAiFloatingReview(el: HTMLElement): void {
    const rect = this.cm.dom.getBoundingClientRect();
    const width = 260;
    const left = Math.min(
      Math.max(12, rect.right - width - 12),
      window.innerWidth - width - 12,
    );
    const top = Math.min(
      Math.max(12, rect.bottom - 44),
      window.innerHeight - 56,
    );
    el.style.width = `${width}px`;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }

  private insertAiFloatingComposer(el: HTMLElement, anchor: HTMLElement): void {
    document.body.appendChild(el);
    this.installShield(el);
    this.positionAiFloatingComposer(el, anchor);
    this.installAiComposerGlobalHandlers();
  }

  private positionAiFloatingComposer(el: HTMLElement, anchor: HTMLElement): void {
    const rect = anchor.getBoundingClientRect();
    const width = Math.min(420, Math.max(320, window.innerWidth - 24));
    const gap = 8;
    const horizontalOffset = 8;
    const left = Math.min(
      Math.max(12, rect.left + horizontalOffset),
      window.innerWidth - width - 12,
    );
    const top = Math.min(rect.bottom + gap, window.innerHeight - 160);
    el.style.width = `${width}px`;
    el.style.left = `${left}px`;
    el.style.top = `${Math.max(12, top)}px`;
  }

  private closeAiComposer(): void {
    this.aiComposerGlobalCleanup?.();
    this.aiComposerGlobalCleanup = null;
    this.aiMentionHandle?.destroy();
    this.aiMentionHandle = null;
    this.aiComposerEl?.remove();
    this.aiComposerEl = null;
  }

  private installAiComposerGlobalHandlers(): void {
    this.aiComposerGlobalCleanup?.();
    const onPointerDown = (ev: PointerEvent) => {
      const target = ev.target as Node | null;
      if (!target) return;
      if (this.aiComposerEl?.contains(target)) return;
      if (target instanceof Element && target.closest("[data-mentions-portal]")) return;
      if (this.headerEl.contains(target)) return;
      if (this.aiReviewEl?.contains(target)) return;
      if (this.resultHostEl?.contains(target)) return;
      this.closeAiComposer();
    };
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      if (this.aiMentionHandle?.isOpen()) return;
      ev.preventDefault();
      this.closeAiComposer();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    this.aiComposerGlobalCleanup = () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }

  private closeAiReview(): void {
    this.aiReviewEl?.remove();
    this.aiReviewEl = null;
  }

  private forwardUpdate(
    update: import("@codemirror/view").ViewUpdate,
  ) {
    if (this.pendingAiRewrite) return;
    if (!this.cm.hasFocus) return;
    const start = (this.getPos() ?? 0) + 1;
    const { main } = update.state.selection;
    const selFrom = start + main.from;
    const selTo = start + main.to;
    const pmSel = this.view.state.selection;
    if (
      update.docChanged ||
      pmSel.from !== selFrom ||
      pmSel.to !== selTo
    ) {
      const tr = this.view.state.tr;
      // fromA 是 CM 变更前文档的绝对坐标；每应用一步 PM 文档长度会变，
      // 必须累加 (newLen - oldLen)，否则像 Cmd+/ 多行注释这种「一次多处插入」
      // 会把后续行写到错误位置（看起来像随机挑几行加了 --）。
      // 公式对齐 https://prosemirror.net/examples/codemirror/
      let off = start;
      update.changes.iterChanges((fromA, toA, fromB, toB, text) => {
        if (text.length) {
          tr.replaceWith(
            off + fromA,
            off + toA,
            this.view.state.schema.text(text.toString()),
          );
        } else {
          tr.delete(off + fromA, off + toA);
        }
        off += toB - fromB - (toA - fromA);
      });
      try {
        tr.setSelection(TextSelection.create(tr.doc, selFrom, selTo));
      } catch {
        // 选区可能因为换行/外部变更暂时越界，吞掉，下个 tick 用户敲键自然恢复
      }
      this.view.dispatch(tr);
    }
  }

  private maybeEscape(
    unit: "char" | "line",
    dir: -1 | 1,
    cm: CMView,
  ): boolean {
    const { state } = cm;
    const { main } = state.selection;
    if (!main.empty) return false;
    let from: number;
    let to: number;
    if (unit === "line") {
      const line = state.doc.lineAt(main.head);
      from = line.from;
      to = line.to;
    } else {
      from = main.from;
      to = main.to;
    }
    if (dir < 0 ? from > 0 : to < state.doc.length) return false;
    const pos = (this.getPos() ?? 0) + (dir < 0 ? 0 : this.node.nodeSize);
    const selection = TextSelection.near(this.view.state.doc.resolve(pos), dir);
    const tr = this.view.state.tr.setSelection(selection).scrollIntoView();
    this.view.dispatch(tr);
    this.view.focus();
    return true;
  }

  // ----- header / footer ---------------------------------------------------

  private renderHeader(node: ProseNode) {
    const language = (node.attrs.language as string) || "plain";
    const attrs = node.attrs as RunSqlAttrs;
    const isRunsql = language === RUNSQL_LANGUAGE;
    const isMermaid = language === MERMAID_LANGUAGE;
    if (isRunsql) {
      const runState = this.effectiveRunState(node);
      const running = runState === "running";
      const label = running ? "Running…" : "Run";
      const formatHint = formatHotkey("Mod+Alt+L");
      this.headerEl.innerHTML = `
        <span class="stela-cb__icon">${DATABASE_ICON_HTML}</span>
        <span class="stela-cb__title">Run SQL</span>
        ${attrs.blockId ? `<span class="stela-cb__id">${escapeHtml(attrs.blockId)}</span>` : ""}
        <button type="button" class="stela-cb__ai stela-cb__ai-rewrite" title="${escapeHtml(i18n.t("ai.runsql.rewriteSql"))}">${AI_ICON_HTML}${escapeHtml(i18n.t("ai.runsql.rewriteShort"))}</button>
        <button type="button" class="stela-cb__ai stela-cb__ai-ask" title="${escapeHtml(i18n.t("ai.runsql.askSql"))}">${AI_ICON_HTML}${escapeHtml(i18n.t("ai.runsql.askShort"))}</button>
        <button type="button" class="stela-cb__format" title="格式化 SQL (${escapeHtml(formatHint)})" aria-label="格式化 SQL">${FORMAT_ICON_HTML}<span class="stela-cb__format-kbd" aria-hidden="true">${escapeHtml(formatHint)}</span></button>
        <button type="button" class="stela-cb__run" data-state="${runState}" ${running ? "disabled" : ""} title="执行 SQL (${formatHotkey("Mod+Enter")})">${PLAY_ICON_HTML}${escapeHtml(label)}<span class="stela-cb__run-kbd" aria-hidden="true">${escapeHtml(formatHotkey("Mod+Enter"))}</span></button>
      `;
      const aiButtons: Array<[string, AiQuickEditMode]> = [
        ["button.stela-cb__ai-rewrite", "rewrite"],
        ["button.stela-cb__ai-ask", "ask"],
      ];
      for (const [selector, mode] of aiButtons) {
        const aiBtn = this.headerEl.querySelector<HTMLButtonElement>(selector);
        if (!aiBtn) continue;
        aiBtn.addEventListener("pointerdown", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
        });
        aiBtn.addEventListener("mousedown", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
        });
        aiBtn.addEventListener("click", (ev) => this.onAiButtonClick(ev, mode));
      }
      const btn = this.headerEl.querySelector<HTMLButtonElement>(
        "button.stela-cb__run",
      );
      if (btn && !running) {
        // pointerdown 比 click 更早触发，规避 ProseMirror / CM 抢占 focus 时吃掉 click
        btn.addEventListener("pointerdown", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
        });
        btn.addEventListener("mousedown", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
        });
        btn.addEventListener("click", this.onRunClick);
      }
      const fmtBtn = this.headerEl.querySelector<HTMLButtonElement>(
        "button.stela-cb__format",
      );
      if (fmtBtn) {
        // 与 Run 按钮同款焦点处理：抢在 PM / CM 之前阻断 pointer / mousedown，
        // 否则点击瞬间 PM 会把选区切到 NodeSelection、CM 失焦、formatSqlCommand
        // 拿到的 view 是过期的（doc 长度还行，但 dispatch 之后光标位置 UX 会闪）。
        fmtBtn.addEventListener("pointerdown", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
        });
        fmtBtn.addEventListener("mousedown", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
        });
        fmtBtn.addEventListener("click", this.onFormatClick);
      }
    } else if (isMermaid) {
      const nextLabel = this.previewMode ? "源码" : "预览";
      const nextIcon = this.previewMode ? CODE_ICON_HTML : EYE_ICON_HTML;
      const title = this.previewMode ? "显示源码" : "显示预览";
      this.headerEl.innerHTML = `
        <span class="stela-cb__icon">${WORKFLOW_ICON_HTML}</span>
        <span class="stela-cb__title">Mermaid</span>
        <button type="button" class="stela-cb__mermaid-toggle" data-preview="${this.previewMode ? "true" : "false"}" title="${title}">${nextIcon}${escapeHtml(nextLabel)}</button>
      `;
      const btn = this.headerEl.querySelector<HTMLButtonElement>(
        "button.stela-cb__mermaid-toggle",
      );
      if (btn) {
        btn.addEventListener("pointerdown", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
        });
        btn.addEventListener("mousedown", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
        });
        btn.addEventListener("click", this.onToggleMermaid);
      }
    } else {
      this.headerEl.innerHTML = `<span class="stela-cb__lang">${escapeHtml(language)}</span>`;
    }
  }

  private onRunClick = (ev: MouseEvent) => {
    ev.preventDefault();
    ev.stopPropagation();
    this.triggerRun();
  };

  private onAiButtonClick = (ev: MouseEvent, mode: AiQuickEditMode) => {
    ev.preventDefault();
    ev.stopPropagation();
    this.showAiComposer(mode, ev.currentTarget as HTMLElement);
  };

  private openAiComposer(mode: AiQuickEditMode): void {
    const selector =
      mode === "rewrite" ? ".stela-cb__ai-rewrite" : ".stela-cb__ai-ask";
    const anchor = this.headerEl.querySelector<HTMLElement>(selector) ?? this.headerEl;
    this.showAiComposer(mode, anchor);
  }

  /** 执行失败后从 result-bar 一键发起 AI 改写（错误信息已在 lastErrorMessage 中）。 */
  private triggerAiFixRewrite(): void {
    this.closeAiComposer();
    this.discardAiRewrite();
    this.closeAiReview();
    this.showAiReview({
      state: "loading",
      message: i18n.t("ai.runsql.rewriting"),
    });
    const selectedText = this.selectedSqlText();
    void this.runSqlRewrite("", selectedText, []);
  }

  private showAiComposer(mode: AiQuickEditMode, anchor: HTMLElement): void {
    this.closeAiComposer();
    this.discardAiRewrite();
    this.closeAiReview();
    const selectedText = this.selectedSqlText();
    const el = document.createElement("div");
    el.className = "stela-cb__ai-quickedit";
    el.setAttribute("contenteditable", "false");
    const title =
      mode === "rewrite"
        ? i18n.t("ai.runsql.rewriteSql")
        : i18n.t("ai.runsql.askSql");
    const placeholder =
      mode === "rewrite"
        ? i18n.t("ai.runsql.rewritePlaceholder")
        : i18n.t("ai.runsql.askPlaceholder");
    const primary = i18n.t("common.send");
    const defaultHint =
      mode === "rewrite"
        ? i18n.t("ai.runsql.rewriteHint")
        : i18n.t("ai.runsql.askHint");
    el.innerHTML = `
      <div class="stela-cb__ai-quickedit-compose">
        <div class="stela-cb__ai-quickedit-row">
          <span class="stela-cb__ai-quickedit-title">${escapeHtml(title)}</span>
          <div class="stela-cb__ai-input-host"></div>
        </div>
        <div class="stela-cb__ai-quickedit-actions">
          <span class="stela-cb__ai-hint">${escapeHtml(defaultHint)}</span>
          <button type="button" class="stela-cb__ai-secondary">${escapeHtml(i18n.t("common.cancel"))}</button>
          <button type="button" class="stela-cb__ai-primary">${escapeHtml(primary)}</button>
        </div>
      </div>
      <div class="stela-cb__ai-result" hidden></div>
    `;
    const inputHost = el.querySelector<HTMLElement>(".stela-cb__ai-input-host");
    const primaryBtn = el.querySelector<HTMLButtonElement>(".stela-cb__ai-primary");
    const cancelBtn = el.querySelector<HTMLButtonElement>(".stela-cb__ai-secondary");
    const hintEl = el.querySelector<HTMLElement>(".stela-cb__ai-hint");
    const resultEl = el.querySelector<HTMLElement>(".stela-cb__ai-result");
    const ctx = getRunContext();
    const connectionName = ctx?.connectionName;
    let mentionInput: MountedTableMentionInputHandle | null = null;
    const syncDisabled = () => {
      if (primaryBtn && mode === "ask") {
        primaryBtn.disabled = mentionInput?.isEmpty() ?? true;
      }
    };
    const setLoading = (loading: boolean, message: string) => {
      el.classList.toggle("stela-cb__ai-quickedit--loading", loading);
      mentionInput?.setDisabled(loading);
      if (cancelBtn) cancelBtn.disabled = loading;
      if (primaryBtn) {
        primaryBtn.disabled = loading ? true : (mode === "ask" ? (mentionInput?.isEmpty() ?? true) : false);
      }
      if (hintEl) {
        hintEl.textContent = message || defaultHint;
        hintEl.setAttribute("aria-live", loading ? "polite" : "off");
      }
    };
    const submit = async () => {
      const userInstruction = mentionInput?.getValue() ?? "";
      const mentionedTables = mentionInput?.getMentionedTables() ?? [];
      if (mode === "ask" && userInstruction.length === 0) return;
      if (mode === "ask" && resultEl) {
        resultEl.hidden = true;
        resultEl.replaceChildren();
      }
      if (mode === "rewrite") {
        setLoading(true, i18n.t("ai.runsql.rewriting"));
        await this.runSqlRewrite(userInstruction, selectedText, mentionedTables);
        return;
      }
      setLoading(true, i18n.t("ai.runsql.asking"));
      await this.runSqlAsk(userInstruction, selectedText, resultEl, setLoading, mentionedTables);
    };
    if (inputHost) {
      mentionInput = mountTableMentionInput(inputHost, {
        placeholder,
        initialValue: mode === "ask" ? selectedText : undefined,
        getTableNamesCached: () =>
          connectionName ? peekAutocompleteFor(connectionName) : [],
        getTableNames: () =>
          connectionName ? ensureAutocompleteFor(connectionName) : Promise.resolve([]),
        onChange: syncDisabled,
        onSubmit: () => void submit(),
        onCancel: () => this.closeAiComposer(),
      });
      this.aiMentionHandle = mentionInput;
    }
    syncDisabled();
    cancelBtn?.addEventListener("click", () => this.closeAiComposer());
    primaryBtn?.addEventListener("click", () => void submit());
    this.aiComposerEl = el;
    this.insertAiFloatingComposer(el, anchor);
    queueMicrotask(() => {
      mentionInput?.focus();
    });
  }

  private async runSqlRewrite(
    userInstruction: string,
    selectedText: string,
    mentionedTables: string[],
  ): Promise<void> {
    this.flushCmToPm();
    const ctx = getRunContext();
    const noteContext = getRunNoteContext();
    const sql = this.cm.state.doc.toString();
    try {
      const response = await window.stela.ai.complete({
        action: "rewrite-sql",
        locale: i18n.resolvedLanguage?.startsWith("zh") ? "zh" : "en",
        context: {
          source: "runsql",
          connectionName: ctx?.connectionName ?? null,
          sql,
          selectedText: selectedText || null,
          ...(noteContext ?? {}),
          errorMessage: this.lastErrorMessage,
          userInstruction: userInstruction || null,
          mentionedTables: mentionedTables.length > 0 ? mentionedTables : undefined,
        },
      });
      if (!response.sql) {
        this.closeAiComposer();
        this.showAiReview({
          state: "error",
          message: response.text || i18n.t("ai.runsql.noSqlReturned"),
        });
        return;
      }
      this.previewAiRewrite(sql, response.sql);
      this.closeAiComposer();
      this.showAiReview({
        state: "ready",
        message: i18n.t("ai.runsql.rewriteReady"),
      });
    } catch (err) {
      this.closeAiComposer();
      this.showAiReview({
        state: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async runSqlAsk(
    userInstruction: string,
    selectedText: string,
    resultEl: HTMLElement | null,
    setLoading: (loading: boolean, message: string) => void,
    mentionedTables: string[],
  ): Promise<void> {
    this.flushCmToPm();
    const ctx = getRunContext();
    const noteContext = getRunNoteContext();
    const sql = this.cm.state.doc.toString();
    try {
      const response = await window.stela.ai.complete({
        action: "ask-sql",
        locale: i18n.resolvedLanguage?.startsWith("zh") ? "zh" : "en",
        context: {
          source: "runsql",
          connectionName: ctx?.connectionName ?? null,
          sql,
          selectedText: selectedText || null,
          ...(noteContext ?? {}),
          userInstruction,
          mentionedTables: mentionedTables.length > 0 ? mentionedTables : undefined,
        },
      });
      setLoading(false, i18n.t("ai.runsql.askReady"));
      if (resultEl) {
        renderMarkdownIntoDom(resultEl, response.text);
        resultEl.hidden = false;
      }
    } catch (err) {
      setLoading(false, err instanceof Error ? err.message : String(err));
    }
  }

  private showAiReview({
    state,
    message,
  }: {
    state: "loading" | "ready" | "error";
    message: string;
  }): void {
    this.closeAiReview();
    const el = document.createElement("div");
    el.className = `stela-cb__ai-review stela-cb__ai-review--${state}`;
    el.setAttribute("contenteditable", "false");
    const keep = i18n.t("ai.runsql.keepRewrite");
    const discard = i18n.t("ai.runsql.discardRewrite");
    const close = i18n.t("ai.panel.close");
    el.innerHTML = `
      <div class="stela-cb__ai-review-top">
        <div class="stela-cb__ai-review-main">
          <span class="stela-cb__ai-review-dot"></span>
          <span class="stela-cb__ai-review-message">${escapeHtml(message)}</span>
        </div>
        <div class="stela-cb__ai-review-actions">
          ${
            state === "ready"
              ? `<button type="button" class="stela-cb__ai-primary">${escapeHtml(keep)}</button>
                 <button type="button" class="stela-cb__ai-secondary">${escapeHtml(discard)}</button>`
              : `<button type="button" class="stela-cb__ai-secondary">${escapeHtml(close)}</button>`
          }
        </div>
      </div>
    `;
    const primary = el.querySelector<HTMLButtonElement>(".stela-cb__ai-primary");
    const secondary = el.querySelector<HTMLButtonElement>(".stela-cb__ai-secondary");
    primary?.addEventListener("click", () => {
      if (state === "ready") {
        this.acceptAiRewrite();
        return;
      }
      this.closeAiReview();
    });
    secondary?.addEventListener("click", () => {
      if (state === "ready") {
        this.discardAiRewrite();
        return;
      }
      this.closeAiReview();
    });
    this.aiReviewEl = el;
    if (state === "ready") {
      el.classList.add("stela-cb__ai-review--floating");
      this.insertAiFloatingReview(el);
    } else {
      this.insertAiAuxElement(el);
    }
  }

  private onFormatClick = (ev: MouseEvent) => {
    ev.preventDefault();
    ev.stopPropagation();
    // 直接驱动 CM command；与 keymap 路径完全一致，formatSqlCommand 内部
    // 已处理空文档 / 解析失败 / 同文本 no-op。
    formatSqlCommand(this.cm);
    // 格式化结束后让 CM 拿回焦点；按钮上的 mousedown 我们已经 preventDefault，
    // activeElement 通常仍是 body（Mermaid toggle 也是同款做法），focus 一下
    // 用户能直接接着敲下一行。
    queueMicrotask(() => {
      if (this.destroyed) return;
      this.cm.focus();
    });
  };

  // ----- 右键菜单 ----------------------------------------------------------

  private onContextMenu = (ev: MouseEvent) => {
    // 让 result-host 里的原生 textarea / 搜索框保持系统菜单体验；只在 header
    // 与 CM 编辑器上拦截（runsql block 的删除 / 运行入口）。
    const t = ev.target as Node | null;
    if (!t) return;
    if (this.resultHostEl && this.resultHostEl.contains(t)) return;

    ev.preventDefault();
    ev.stopPropagation();

    const isRunsql = this.node.attrs.language === RUNSQL_LANGUAGE;
    const items: MenuEntry[] = [];
    if (isRunsql) {
      items.push(
        {
          label: i18n.t("agent.addToChat"),
          shortcut: formatHotkey("Mod+I"),
          onSelect: () => this.addCurrentSqlToChat(),
        },
        { kind: "separator" },
        {
          label: "运行",
          shortcut: formatHotkey("Mod+Enter"),
          onSelect: () => this.triggerRun(),
        },
        {
          label: "刷新结果",
          shortcut: formatHotkey("Mod+R"),
          onSelect: () => this.refreshResult(),
          disabled: !this.node.attrs.detail,
        },
        {
          label: i18n.t("ai.runsql.rewriteSql"),
          onSelect: () => this.openAiComposer("rewrite"),
        },
        {
          label: i18n.t("ai.runsql.askSql"),
          onSelect: () => this.openAiComposer("ask"),
        },
        { kind: "separator" },
        {
          label: "复制 SQL",
          onSelect: () => {
            const sql = this.node.textContent;
            void navigator.clipboard.writeText(sql).catch((err) => {
              console.warn("[stela] copy sql failed", err);
            });
          },
        },
      );
    } else {
      items.push(
        {
          label: i18n.t("agent.addToChat"),
          shortcut: formatHotkey("Mod+I"),
          onSelect: () => {
            const selectedText = this.selectedSqlText();
            addSelectionToChat(
              selectedText.trim() ? selectedText : this.node.textContent,
              "Code block",
            );
          },
        },
        { kind: "separator" },
        {
          label: "复制代码",
          onSelect: () => {
            void navigator.clipboard
              .writeText(this.node.textContent)
              .catch((err) => console.warn("[stela] copy code failed", err));
          },
        },
      );
    }
    items.push({ kind: "separator" });
    items.push({
      label: "删除此块",
      destructive: true,
      onSelect: () => this.deleteBlock(),
    });

    showContextMenu({ x: ev.clientX, y: ev.clientY, items });
  };

  private refreshResult() {
    this.refreshNonce += 1;
    this.renderResult(this.node);
  }

  private deleteBlock() {
    const pos = this.getPos();
    if (pos === undefined) return;
    const size = this.node.nodeSize;
    const tr = this.view.state.tr.delete(pos, pos + size);
    this.view.dispatch(tr);
    this.view.focus();
  }

  private triggerRun() {
    this.lastErrorMessage = null;
    this.renderResult(this.node);
    void runBlock(this.node, this.view, this.getPos)
      .then((outcome) => {
        if (!outcome.ok && outcome.message) {
          this.lastErrorMessage = outcome.message;
          this.renderResult(this.node);
        } else {
          this.lastErrorMessage = null;
        }
      })
      .catch((err) => {
        console.error("[stela] run threw", err);
        this.lastErrorMessage =
          err instanceof Error ? err.message : String(err);
        this.renderResult(this.node);
      });
  }

  private renderResult(node: ProseNode) {
    if (!this.resultRoot) return;
    const attrs = node.attrs as RunSqlAttrs;
    const detail = attrs.detail ?? null;
    const runState = this.effectiveRunState(node);
    const runId = detail?.resultRefId ?? null;
    const blockId = attrs.blockId ?? detail?.blockId ?? null;

    // 新执行完成（最新 runId 变化）→ 重置历史浏览 / 比对态到「最新」
    if (runId !== this.lastSeenRunId) {
      this.lastSeenRunId = runId;
      this.resultViewState = DEFAULT_VIEW_STATE;
    }

    this.resultRoot.render(
      createElement(BlockResult, {
        runId,
        blockId,
        detail,
        runState,
        errorMessage: this.lastErrorMessage,
        expanded: this.resultExpanded,
        refreshNonce: this.refreshNonce,
        viewState: this.resultViewState,
        onViewStateChange: (next: BlockResultViewState) => {
          this.resultViewState = next;
          this.renderResult(this.node);
        },
        onToggle: () => {
          this.resultExpanded = !this.resultExpanded;
          this.renderResult(this.node);
        },
        onAiFix:
          runState === "error" && this.lastErrorMessage
            ? () => this.triggerAiFixRewrite()
            : undefined,
      }),
    );
  }

  private effectiveRunState(node: ProseNode): RunStateValue {
    const attrs = node.attrs as RunSqlAttrs;
    const explicit = attrs.runState ?? "idle";
    if (explicit !== "idle") return explicit;
    const tabId = useWorkspace.getState().activeTabId;
    if (!tabId) return explicit;
    const blockId = attrs.blockId ?? attrs.detail?.blockId ?? null;
    if (
      isRunsqlBlockPending({
        tabId,
        blockId,
        blockIndex: this.currentRunsqlBlockIndex(),
        sql: node.textContent,
      })
    ) {
      return "running";
    }
    return explicit;
  }

  private currentRunsqlBlockIndex(): number {
    const pos = this.getPos();
    if (pos === undefined) return 0;
    let index = 0;
    let found = 0;
    this.view.state.doc.descendants((node, nodePos) => {
      if (
        node.type.name !== "code_block" ||
        (node.attrs.language as string | undefined) !== RUNSQL_LANGUAGE ||
        !node.textContent.trim()
      ) {
        return;
      }
      if (nodePos === pos) {
        found = index;
        return false;
      }
      index++;
      return;
    });
    return found;
  }

  // ----- mermaid 预览 ------------------------------------------------------

  /** 创建预览 host（若已存在则直接返回）。host 总是挂在 dom 末尾。 */
  private ensurePreviewHost() {
    if (this.previewHostEl) return;
    const host = document.createElement("div");
    host.className = "stela-cb__preview-host";
    host.setAttribute("contenteditable", "false");
    this.dom.appendChild(host);
    this.previewHostEl = host;
    this.installShield(host);
  }

  /** 拆掉预览 host（language 切走 mermaid 时）。 */
  private teardownPreviewHost() {
    if (this.mermaidDebounceTimer) {
      clearTimeout(this.mermaidDebounceTimer);
      this.mermaidDebounceTimer = null;
    }
    this.previewHostEl?.remove();
    this.previewHostEl = null;
  }

  /**
   * 防抖触发 mermaid 渲染。immediate=true 时跳过 debounce 立即渲染（构造时首屏用）。
   */
  private scheduleMermaidRender(source: string, immediate = false) {
    if (this.mermaidDebounceTimer) {
      clearTimeout(this.mermaidDebounceTimer);
      this.mermaidDebounceTimer = null;
    }
    if (immediate) {
      void this.renderMermaidPreview(source);
      return;
    }
    this.mermaidDebounceTimer = setTimeout(() => {
      this.mermaidDebounceTimer = null;
      void this.renderMermaidPreview(source);
    }, MERMAID_RENDER_DEBOUNCE_MS);
  }

  private async renderMermaidPreview(source: string): Promise<void> {
    if (!this.previewHostEl) return;
    const host = this.previewHostEl;
    const trimmed = source.trim();
    if (!trimmed) {
      // 空源码：显示占位符，避免 mermaid.render 抛 "No diagram type detected"
      host.innerHTML = `<div class="stela-cb__mermaid-empty">输入 mermaid 源码，预览会显示在这里</div>`;
      return;
    }

    const token = ++this.mermaidRenderToken;
    // 首次渲染时若 host 里还没有任何内容，展示一个 loading 占位；已有旧 SVG 时保留
    if (!host.querySelector("svg")) {
      host.innerHTML = `<div class="stela-cb__mermaid-loading">渲染中…</div>`;
    }
    try {
      const svg = await renderMermaid(this.mermaidId, trimmed);
      if (this.destroyed) return;
      if (token !== this.mermaidRenderToken) return;
      host.innerHTML = svg;
    } catch (err) {
      if (this.destroyed) return;
      if (token !== this.mermaidRenderToken) return;
      const message = err instanceof Error ? err.message : String(err);
      // 有旧 SVG 就保留旧图 + 顶部红条提示；否则只展示错误
      const prevSvg = host.querySelector("svg");
      const errorBar = `<div class="stela-cb__mermaid-error">${escapeHtml(message)}</div>`;
      if (prevSvg) {
        const clone = prevSvg.cloneNode(true) as SVGElement;
        host.innerHTML = errorBar;
        host.appendChild(clone);
      } else {
        host.innerHTML = errorBar;
      }
    }
  }

  private onToggleMermaid = (ev: MouseEvent) => {
    ev.preventDefault();
    ev.stopPropagation();
    this.previewMode = !this.previewMode;
    this.dom.dataset.preview = this.previewMode ? "true" : "false";
    this.renderHeader(this.node);
    if (this.previewMode) {
      this.scheduleMermaidRender(this.node.textContent, /*immediate*/ true);
    } else {
      // 切到源码：让 CM 获得焦点方便直接编辑
      queueMicrotask(() => {
        if (this.destroyed) return;
        this.cm.focus();
      });
    }
  };
}

type SqlDiffOp =
  | { kind: "equal"; line: string }
  | { kind: "removed"; line: string }
  | { kind: "added"; line: string };

class RemovedSqlLineWidget extends WidgetType {
  constructor(private readonly line: string) {
    super();
  }

  override eq(other: RemovedSqlLineWidget): boolean {
    return other.line === this.line;
  }

  override toDOM(): HTMLElement {
    const row = document.createElement("div");
    row.className = "cm-stela-ai-removed-widget";
    const marker = document.createElement("span");
    marker.className = "cm-stela-ai-line-marker";
    marker.textContent = "-";
    const code = document.createElement("code");
    code.textContent = this.line || " ";
    row.append(marker, code);
    return row;
  }
}

function buildAiRewriteDiffExtension(
  originalSql: string,
  proposedSql: string,
): Extension {
  const ranges: Range<Decoration>[] = [];
  const proposedDoc = CMState.create({ doc: proposedSql }).doc;
  const ops = diffSqlLines(
    originalSql.split(/\r?\n/),
    proposedSql.split(/\r?\n/),
  );
  let proposedLine = 1;
  for (const op of ops) {
    if (op.kind === "equal") {
      proposedLine += 1;
      continue;
    }
    if (op.kind === "added") {
      const line = proposedDoc.line(Math.min(proposedLine, proposedDoc.lines));
      ranges.push(
        Decoration.line({ class: "cm-stela-ai-added-line" }).range(line.from),
      );
      proposedLine += 1;
      continue;
    }
    const anchor =
      proposedLine <= proposedDoc.lines
        ? proposedDoc.line(proposedLine).from
        : proposedDoc.length;
    ranges.push(
      Decoration.widget({
        widget: new RemovedSqlLineWidget(op.line),
        block: true,
        side: -1,
      }).range(anchor),
    );
  }

  return [
    CMState.readOnly.of(true),
    CMView.editable.of(false),
    CMView.decorations.of(Decoration.set(ranges, true)),
  ];
}

function isKnownTable(
  tableNames: readonly string[],
  db: string | null,
  table: string,
): boolean {
  if (db) return tableNames.includes(`${db}.${table}`);
  return tableNames.includes(table) || tableNames.some((name) => name.endsWith(`.${table}`));
}

function diffSqlLines(original: string[], proposed: string[]): SqlDiffOp[] {
  if (original.length * proposed.length > 40_000) {
    return diffSqlLinesByPrefixSuffix(original, proposed);
  }
  const rows = original.length + 1;
  const cols = proposed.length + 1;
  const dp = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = original.length - 1; i >= 0; i -= 1) {
    for (let j = proposed.length - 1; j >= 0; j -= 1) {
      dp[i]![j] =
        original[i] === proposed[j]
          ? dp[i + 1]![j + 1]! + 1
          : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const ops: SqlDiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < original.length && j < proposed.length) {
    if (original[i] === proposed[j]) {
      ops.push({ kind: "equal", line: original[i]! });
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ kind: "removed", line: original[i]! });
      i += 1;
    } else {
      ops.push({ kind: "added", line: proposed[j]! });
      j += 1;
    }
  }
  while (i < original.length) {
    ops.push({ kind: "removed", line: original[i]! });
    i += 1;
  }
  while (j < proposed.length) {
    ops.push({ kind: "added", line: proposed[j]! });
    j += 1;
  }
  return ops;
}

function diffSqlLinesByPrefixSuffix(
  original: string[],
  proposed: string[],
): SqlDiffOp[] {
  let prefix = 0;
  while (
    prefix < original.length &&
    prefix < proposed.length &&
    original[prefix] === proposed[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < original.length - prefix &&
    suffix < proposed.length - prefix &&
    original[original.length - 1 - suffix] ===
      proposed[proposed.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return [
    ...original.slice(0, prefix).map<SqlDiffOp>((line) => ({ kind: "equal", line })),
    ...original
      .slice(prefix, original.length - suffix)
      .map<SqlDiffOp>((line) => ({ kind: "removed", line })),
    ...proposed
      .slice(prefix, proposed.length - suffix)
      .map<SqlDiffOp>((line) => ({ kind: "added", line })),
    ...original
      .slice(original.length - suffix)
      .map<SqlDiffOp>((line) => ({ kind: "equal", line })),
  ];
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
