/**
 * 编辑器内浮动 find bar（Cmd+F / Cmd+Alt+F）。
 *
 * 视觉规格：
 *   - 位置：`.stela-milkdown-host` 内右上角，position: absolute；
 *   - 两行布局：
 *     * 第一行（find）：keyword input + 计数（"3 / 17"）+ 上一/下一/Aa 切换 + 关闭 X；
 *     * 第二行（replace 模式才出现）：replacement input + Replace + Replace All；
 *   - 紧凑：单行 28px，replace 模式 ~62px；
 *   - 不强抢 PM 焦点：仅 input 自己 focus，PM 选区保持。
 *
 * 行为：
 *   - keyword 变化 250ms 防抖 → controller.refresh()；
 *   - Enter → next（Shift+Enter → prev）；
 *   - replace input 上 Enter → replace；
 *   - Esc / X 按钮 → controller.close() + view.focus()；
 *   - 重复 Cmd+F（focusToken 递增）→ 全选 keyword 输入框（Chrome 行为）。
 *
 * 输入事件 stopPropagation：bar 内 keydown / keyup 不冒泡到 PM，避免被 PM 拦走（比如
 * a / s / d 在 PM 内会触发字符插入）。这一层在每个 input/button 上单独处理。
 */

import {
  ArrowDown,
  ArrowUp,
  CaseSensitive,
  ChevronDown,
  ChevronRight,
  Replace as ReplaceIcon,
  ReplaceAll as ReplaceAllIcon,
  X,
} from "lucide-react";
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MutableRefObject,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from "react";

import { cn } from "@/lib/utils";

import type { EditorView } from "@milkdown/prose/view";

import * as controller from "./find-controller";
import { useFindState } from "./use-find-state";

interface Props {
  /** 当前 PM EditorView 的 ref（由 MilkdownEditor 拥有）。 */
  viewRef: MutableRefObject<EditorView | null>;
}

const REFRESH_DEBOUNCE_MS = 200;

function FindBarImpl({ viewRef }: Props) {
  const isOpen = useFindState((s) => s.isOpen);
  const mode = useFindState((s) => s.mode);
  const keyword = useFindState((s) => s.keyword);
  const replacement = useFindState((s) => s.replacement);
  const caseSensitive = useFindState((s) => s.caseSensitive);
  const activeIndex = useFindState((s) => s.activeIndex);
  const totalMatches = useFindState((s) => s.totalMatches);
  const focusToken = useFindState((s) => s.focusToken);

  const setKeyword = useFindState((s) => s.setKeyword);
  const setReplacement = useFindState((s) => s.setReplacement);
  const toggleCaseSensitive = useFindState((s) => s.toggleCaseSensitive);
  const setMode = useFindState((s) => s.setMode);

  const keywordRef = useRef<HTMLInputElement>(null);
  const replacementRef = useRef<HTMLInputElement>(null);

  // controller opts —— 闭包稳定，多次 next/prev 不重建。
  const opts = useMemo(
    () => ({ getView: () => viewRef.current }),
    [viewRef],
  );

  // 打开 / 模式切换时聚焦 keyword 输入并全选（Chrome 行为）。
  useEffect(() => {
    if (!isOpen) return;
    const el = keywordRef.current;
    if (!el) return;
    // requestAnimationFrame 等 DOM 渲染完成；避免 input 还没挂到 DOM 时 focus 无效。
    const raf = requestAnimationFrame(() => {
      el.focus({ preventScroll: true });
      el.select();
    });
    return () => cancelAnimationFrame(raf);
  }, [isOpen, focusToken, mode]);

  // keyword / caseSensitive 变化 → 防抖 refresh。
  // 若关键字清空（length===0），同步清掉 active reveal（不防抖，体感更跟手）。
  useEffect(() => {
    if (!isOpen) return;
    if (keyword.length === 0) {
      controller.refresh(opts);
      return;
    }
    const handle = window.setTimeout(() => {
      controller.refresh(opts);
    }, REFRESH_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [keyword, caseSensitive, isOpen, opts]);

  // editor 销毁 / 切 tab 等 → 关闭 bar 时同步 cleanup（teardown）。
  useEffect(() => {
    if (isOpen) return;
    controller.teardown();
  }, [isOpen]);

  const closeAndFocus = useCallback(() => {
    controller.close();
    // 把焦点还给 PM editor，让用户可以马上继续编辑
    viewRef.current?.focus();
  }, [viewRef]);

  // 仅对"我们要消费的键"做 preventDefault + stopPropagation；其它键放行让全局 hotkey
  // 仍然能在 bar 输入态下生效（如 Mod+B 折叠侧栏、Mod+Shift+F 切到 vault 搜索）。
  // bar 现在挂在 host 兄弟节点上，普通键不会冒泡到 PM，所以无需无差别 stopPropagation。
  const onKeywordKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        if (e.shiftKey) controller.prev(opts);
        else controller.next(opts);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeAndFocus();
        return;
      }
    },
    [opts, closeAndFocus],
  );

  const onReplacementKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        if (e.shiftKey || e.metaKey || e.ctrlKey) controller.replaceAll(opts);
        else controller.replace(opts);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeAndFocus();
      }
    },
    [opts, closeAndFocus],
  );

  // hooks 顺序稳定：放在所有 early return 之前
  const counter = useMemo(() => {
    if (keyword.length === 0) return "";
    if (totalMatches === 0) return "0 results";
    return `${activeIndex + 1} / ${totalMatches}`;
  }, [keyword, totalMatches, activeIndex]);

  if (!isOpen) return null;

  const hasMatches = totalMatches > 0;
  // 占位偏移：让 bar 不被自定义 host 滚动条挡到。
  const containerStyle: CSSProperties = { right: 16, top: 8 };

  return (
    <div
      className="stela-find-bar"
      style={containerStyle}
      role="toolbar"
      aria-label="Find in file"
      // 阻止 bar 上的 mousedown 把 PM 焦点抢走 / 触发 PM 选区改变
      onMouseDown={(e) => {
        // input/button 上的 mousedown 还是要正常走，让 input 拿焦点
        const tag = (e.target as HTMLElement).tagName;
        if (tag !== "INPUT" && tag !== "BUTTON") e.preventDefault();
      }}
    >
      <div className="stela-find-bar__row">
        <button
          type="button"
          className="stela-find-bar__btn stela-find-bar__btn--toggle"
          onClick={(e) => {
            e.preventDefault();
            // 第一行最左边的折叠箭头：点击在 find ↔ replace 之间切换。
            // setMode 内部 ++ focusToken，所以切完后焦点会回到 keyword 输入框。
            setMode(mode === "replace" ? "find" : "replace");
          }}
          onKeyDown={(e) => e.stopPropagation()}
          title={
            mode === "replace"
              ? "收起替换 (Cmd+Alt+F 切换)"
              : "展开替换 (Cmd+Alt+F)"
          }
          aria-label="Toggle replace"
          aria-expanded={mode === "replace"}
        >
          {mode === "replace" ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </button>
        <input
          ref={keywordRef}
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          onKeyDown={onKeywordKeyDown}
          placeholder="Find"
          className="stela-find-bar__input"
          spellCheck={false}
          aria-label="Find keyword"
        />
        <span
          className={cn(
            "stela-find-bar__counter",
            !hasMatches && keyword.length > 0 && "stela-find-bar__counter--empty",
          )}
          aria-live="polite"
        >
          {counter}
        </span>
        <button
          type="button"
          className={cn(
            "stela-find-bar__btn",
            caseSensitive && "stela-find-bar__btn--active",
          )}
          onClick={(e) => {
            e.preventDefault();
            toggleCaseSensitive();
          }}
          onKeyDown={(e) => e.stopPropagation()}
          title="区分大小写 (Aa)"
          aria-pressed={caseSensitive}
        >
          <CaseSensitive className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          className="stela-find-bar__btn"
          onClick={(e) => {
            e.preventDefault();
            controller.prev(opts);
          }}
          onKeyDown={(e) => e.stopPropagation()}
          disabled={!hasMatches}
          title="上一个 (Shift+Enter)"
          aria-label="Previous match"
        >
          <ArrowUp className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          className="stela-find-bar__btn"
          onClick={(e) => {
            e.preventDefault();
            controller.next(opts);
          }}
          onKeyDown={(e) => e.stopPropagation()}
          disabled={!hasMatches}
          title="下一个 (Enter)"
          aria-label="Next match"
        >
          <ArrowDown className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          className="stela-find-bar__btn stela-find-bar__btn--close"
          onClick={(e) => {
            e.preventDefault();
            closeAndFocus();
          }}
          onKeyDown={(e) => e.stopPropagation()}
          title="关闭 (Esc)"
          aria-label="Close"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {mode === "replace" ? (
        <div className="stela-find-bar__row stela-find-bar__row--replace">
          <input
            ref={replacementRef}
            value={replacement}
            onChange={(e) => setReplacement(e.target.value)}
            onKeyDown={onReplacementKeyDown}
            placeholder="Replace"
            className="stela-find-bar__input"
            spellCheck={false}
            aria-label="Replacement"
          />
          <button
            type="button"
            className="stela-find-bar__btn"
            onClick={(e) => {
              e.preventDefault();
              controller.replace(opts);
            }}
            onKeyDown={(e) => e.stopPropagation()}
            disabled={!hasMatches}
            title="替换当前 (Enter)"
            aria-label="Replace"
          >
            <ReplaceIcon className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className="stela-find-bar__btn"
            onClick={(e) => {
              e.preventDefault();
              controller.replaceAll(opts);
            }}
            onKeyDown={(e) => e.stopPropagation()}
            disabled={!hasMatches}
            title="全部替换 (Shift+Enter / Cmd+Enter)"
            aria-label="Replace all"
          >
            <ReplaceAllIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : null}
    </div>
  );
}

export const FindBar = memo(FindBarImpl);
