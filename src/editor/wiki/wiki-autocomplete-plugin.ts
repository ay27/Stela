/**
 * Wiki link 自动补全 ProseMirror plugin（v0.3 双链 M2）。
 *
 * 触发：用户在普通文本上下文中输入 `[[`，且光标到 `[[` 之间没出现 `]]` /
 * 换行 / `|` 时进入 active 状态，从 main 端拉候选并在光标附近弹 popover。
 *
 * 接受：popover 选中条目 → 移除 `[[query` 文本 → 在原位插入 `wikiLink` atom
 * 节点（target 来自候选）+ 一个空格分隔符。
 *
 * 取消：Esc / 失焦 / 光标移开 / 删到只剩一个 `[`。
 *
 * 不依赖 React：popover 用原生 DOM，挂到 document.body，position fixed，
 * 跟随窗口滚动；与 RunSQL NodeView 同一套朴素风格。
 */

import { Plugin, PluginKey } from "@milkdown/prose/state";
import type { EditorState, Transaction } from "@milkdown/prose/state";
import type { EditorView } from "@milkdown/prose/view";
import { $prose } from "@milkdown/utils";

import type { IndexCandidate } from "@shared/types";

import { WIKI_LINK_NODE_NAME } from "./wiki-link-schema";

const POPOVER_CLASS = "stela-wiki-popover";
const MAX_VISIBLE_ROWS = 8;
const SCAN_BACK = 200;
const FETCH_DEBOUNCE_MS = 80;

export interface AutocompleteState {
  /** 触发上下文 = `[[` 起始位置（PM 文档坐标）→ 光标位置 + 当前已输入 query */
  active: { from: number; to: number; query: string } | null;
  selectedIdx: number;
  candidates: IndexCandidate[];
  /** 当前正在 fetch 的 query；用于丢弃陈旧响应 */
  pendingQuery: string | null;
}

const initialState: AutocompleteState = {
  active: null,
  selectedIdx: 0,
  candidates: [],
  pendingQuery: null,
};

export const wikiAutocompleteKey = new PluginKey<AutocompleteState>(
  "stela-wiki-autocomplete",
);

/** 从光标向前回溯，识别 `[[query` 触发上下文。 */
function detectTrigger(state: EditorState): AutocompleteState["active"] {
  const sel = state.selection;
  if (!sel.empty) return null;
  const $cur = sel.$from;
  // 仅在叶子文本节点的父节点是 inline-allowing 的位置生效；
  // RunSQL / mermaid 等 code_block 内部由 NodeView 的 CM 编辑器自管，不会
  // 触达本 plugin（PM 不会把 CM 内部按键转发上来）。
  const parent = $cur.parent;
  if (!parent.isTextblock) return null;
  const blockStart = $cur.start();
  const sliceStart = Math.max(blockStart, sel.from - SCAN_BACK);
  const before = state.doc.textBetween(sliceStart, sel.from, "\n", "");
  // 必须以 [[ 起始且后续不含 ] / | / 换行（| 之后是 alias，超出补全语义）
  const m = /\[\[([^\[\]\|\r\n]*)$/.exec(before);
  if (!m) return null;
  return {
    from: sel.from - m[0].length,
    to: sel.from,
    query: m[1],
  };
}

interface PopoverItemEl {
  el: HTMLDivElement;
  candidate: IndexCandidate;
}

class AutocompleteView {
  private root: HTMLDivElement;
  private listEl: HTMLDivElement;
  private hintEl: HTMLDivElement;
  private items: PopoverItemEl[] = [];
  private fetchTimer: ReturnType<typeof setTimeout> | null = null;
  private indexUnsub: (() => void) | null = null;

  constructor(private readonly view: EditorView) {
    this.root = document.createElement("div");
    this.root.className = POPOVER_CLASS;
    this.root.setAttribute("role", "listbox");
    this.root.style.display = "none";
    this.listEl = document.createElement("div");
    this.listEl.className = `${POPOVER_CLASS}__list`;
    this.hintEl = document.createElement("div");
    this.hintEl.className = `${POPOVER_CLASS}__hint`;
    this.hintEl.textContent = "↑↓ 选择 · Enter 接受 · Esc 取消";
    this.root.appendChild(this.listEl);
    this.root.appendChild(this.hintEl);
    document.body.appendChild(this.root);

    this.root.addEventListener("mousedown", this.onPopoverMouseDown);

    // 索引在 main 进程更新时清空候选缓存：用 onChanged 触发当前 query 重新拉。
    if (typeof window !== "undefined" && window.stela?.index?.onChanged) {
      this.indexUnsub = window.stela.index.onChanged(() => {
        const cur = wikiAutocompleteKey.getState(this.view.state);
        if (cur?.active) this.scheduleFetch(cur.active.query);
      });
    }
  }

  update(view: EditorView, prevState: EditorState): void {
    const next = wikiAutocompleteKey.getState(view.state);
    const prev = wikiAutocompleteKey.getState(prevState);
    if (!next) return;

    const active = next.active;
    if (!active) {
      this.hide();
      return;
    }

    const queryChanged = active.query !== prev?.active?.query;
    const candidatesChanged = next.candidates !== prev?.candidates;
    const selectedChanged = next.selectedIdx !== prev?.selectedIdx;
    const positionChanged = active.from !== prev?.active?.from;

    if (queryChanged) this.scheduleFetch(active.query);
    if (candidatesChanged || queryChanged) this.renderList(next);
    else if (selectedChanged) this.refreshSelection(next.selectedIdx);

    if (positionChanged || queryChanged || this.root.style.display === "none") {
      this.position(active.from);
      this.root.style.display = "block";
    }
  }

  destroy(): void {
    if (this.fetchTimer) clearTimeout(this.fetchTimer);
    this.fetchTimer = null;
    this.root.removeEventListener("mousedown", this.onPopoverMouseDown);
    this.root.remove();
    if (this.indexUnsub) {
      this.indexUnsub();
      this.indexUnsub = null;
    }
  }

  /** 阻止 popover 内部点击导致 PM 失焦（失焦会立刻 hide popover） */
  private onPopoverMouseDown = (ev: MouseEvent) => {
    ev.preventDefault();
  };

  private hide(): void {
    if (this.root.style.display !== "none") this.root.style.display = "none";
  }

  private position(fromPos: number): void {
    const coords = (() => {
      try {
        return this.view.coordsAtPos(fromPos);
      } catch {
        return null;
      }
    })();
    if (!coords) return;
    const top = coords.bottom + 4;
    const left = coords.left;
    this.root.style.top = `${top}px`;
    this.root.style.left = `${left}px`;
  }

  private scheduleFetch(query: string): void {
    if (this.fetchTimer) clearTimeout(this.fetchTimer);
    this.fetchTimer = setTimeout(() => {
      this.fetchTimer = null;
      this.runFetch(query);
    }, FETCH_DEBOUNCE_MS);
  }

  private async runFetch(query: string): Promise<void> {
    if (typeof window === "undefined" || !window.stela?.index) return;
    // 在状态里记 pendingQuery，丢弃过期响应
    this.dispatchMeta({ pendingQuery: query });
    let candidates: IndexCandidate[] = [];
    try {
      candidates = await window.stela.index.listCandidates(
        query,
        MAX_VISIBLE_ROWS * 4,
      );
    } catch (err) {
      console.warn("[stela] wiki autocomplete fetch failed", err);
      candidates = [];
    }
    const cur = wikiAutocompleteKey.getState(this.view.state);
    if (!cur?.active) return;
    if (cur.pendingQuery !== null && cur.pendingQuery !== query) return;
    if (cur.active.query !== query) return;
    this.dispatchMeta({
      candidates,
      pendingQuery: null,
      selectedIdx: 0,
    });
  }

  private dispatchMeta(partial: Partial<AutocompleteState>): void {
    const tr = this.view.state.tr.setMeta(wikiAutocompleteKey, partial);
    this.view.dispatch(tr);
  }

  private renderList(state: AutocompleteState): void {
    this.listEl.innerHTML = "";
    this.items = [];
    if (state.candidates.length === 0) {
      const empty = document.createElement("div");
      empty.className = `${POPOVER_CLASS}__empty`;
      empty.textContent = state.active?.query
        ? `没有匹配「${state.active.query}」的笔记`
        : "暂无笔记";
      this.listEl.appendChild(empty);
      return;
    }
    state.candidates.slice(0, MAX_VISIBLE_ROWS * 4).forEach((c, i) => {
      const row = document.createElement("div");
      row.className = `${POPOVER_CLASS}__row`;
      row.setAttribute("role", "option");
      if (i === state.selectedIdx) row.classList.add("is-selected");
      row.dataset.index = String(i);

      const label = document.createElement("span");
      label.className = `${POPOVER_CLASS}__label`;
      label.textContent = c.label;

      const detail = document.createElement("span");
      detail.className = `${POPOVER_CLASS}__detail`;
      detail.textContent = c.detail;

      const kind = document.createElement("span");
      kind.className = `${POPOVER_CLASS}__kind`;
      kind.textContent = c.kind === "heading" ? "H" : c.kind === "blockId" ? "#" : "•";

      row.appendChild(kind);
      row.appendChild(label);
      row.appendChild(detail);
      row.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        this.acceptIndex(i);
      });
      this.listEl.appendChild(row);
      this.items.push({ el: row, candidate: c });
    });
  }

  private refreshSelection(selectedIdx: number): void {
    this.items.forEach((it, i) => {
      it.el.classList.toggle("is-selected", i === selectedIdx);
      if (i === selectedIdx) {
        it.el.scrollIntoView({ block: "nearest" });
      }
    });
  }

  private acceptIndex(idx: number): void {
    const cur = wikiAutocompleteKey.getState(this.view.state);
    if (!cur?.active) return;
    const candidate = cur.candidates[idx];
    if (!candidate) return;
    accept(this.view, cur.active, candidate);
  }
}

function accept(
  view: EditorView,
  active: NonNullable<AutocompleteState["active"]>,
  candidate: IndexCandidate,
): void {
  const { state } = view;
  const wikiType = state.schema.nodes[WIKI_LINK_NODE_NAME];
  if (!wikiType) return;
  const node = wikiType.create({
    target: candidate.target,
    alias: null,
    resolved: "unknown",
  });
  const tr = state.tr;
  tr.replaceWith(active.from, active.to, node);
  // 在节点之后补一个空格，方便用户继续输入
  const after = active.from + node.nodeSize;
  tr.insertText(" ", after);
  tr.setMeta(wikiAutocompleteKey, { active: null, candidates: [] });
  view.dispatch(tr);
  view.focus();
}

const wikiAutocompletePluginRaw = new Plugin<AutocompleteState>({
  key: wikiAutocompleteKey,
  state: {
    init: (): AutocompleteState => initialState,
    apply: (tr: Transaction, prev: AutocompleteState, _oldState, newState) => {
      const meta = tr.getMeta(wikiAutocompleteKey) as
        | Partial<AutocompleteState>
        | undefined;
      const merged: AutocompleteState = { ...prev, ...(meta ?? {}) };
      // doc / selection 改变时重算 active；但 meta 已显式 active=null 时尊重之
      if (meta && Object.prototype.hasOwnProperty.call(meta, "active")) {
        return merged;
      }
      const next = detectTrigger(newState);
      if (!next) {
        if (!merged.active) return merged;
        return { ...merged, active: null, candidates: [], selectedIdx: 0 };
      }
      const sameQuery = merged.active?.query === next.query;
      return {
        ...merged,
        active: next,
        selectedIdx: sameQuery ? merged.selectedIdx : 0,
        candidates: sameQuery ? merged.candidates : merged.candidates,
      };
    },
  },
  props: {
    handleKeyDown(view, event) {
      const cur = wikiAutocompleteKey.getState(view.state);
      if (!cur?.active) return false;
      // 候选还没回来时，仅 Esc 主动关闭；其余按键放给 PM 默认处理。
      const hasCandidates = cur.candidates.length > 0;
      switch (event.key) {
        case "Escape": {
          view.dispatch(
            view.state.tr.setMeta(wikiAutocompleteKey, {
              active: null,
              candidates: [],
              selectedIdx: 0,
            }),
          );
          return true;
        }
        case "ArrowDown": {
          if (!hasCandidates) return false;
          const next = Math.min(cur.selectedIdx + 1, cur.candidates.length - 1);
          view.dispatch(
            view.state.tr.setMeta(wikiAutocompleteKey, { selectedIdx: next }),
          );
          return true;
        }
        case "ArrowUp": {
          if (!hasCandidates) return false;
          const next = Math.max(cur.selectedIdx - 1, 0);
          view.dispatch(
            view.state.tr.setMeta(wikiAutocompleteKey, { selectedIdx: next }),
          );
          return true;
        }
        case "Enter":
        case "Tab": {
          if (!hasCandidates) return false;
          const candidate = cur.candidates[cur.selectedIdx];
          if (!candidate) return false;
          accept(view, cur.active, candidate);
          return true;
        }
        default:
          return false;
      }
    },
  },
  view(editorView) {
    return new AutocompleteView(editorView);
  },
});

export const wikiAutocompletePlugin = $prose(() => wikiAutocompletePluginRaw);
