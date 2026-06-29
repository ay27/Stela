/**
 * Stela 文档编辑器（Milkdown 实现）。
 *
 *   - 用 Crepe preset 起步——拿到 toolbar / slash / list-item / link-tooltip 等开箱体验
 *   - 关闭 Crepe 自带的 CodeMirror feature，换成 [src/editor/runsql/](src/editor/runsql/)
 *     的自定义 NodeView，code_block 全部走 RunSQL / 简洁代码块两条路径
 *   - frontmatter 在挂载/保存时由 [src/core/markdown.ts](src/core/markdown.ts) 剥/拼，
 *     Milkdown 内部只看 body
 *   - 通过 `listener.markdownUpdated` 监听变更，800ms debounce 后调用 `onPersist`
 *
 * 关于 React StrictMode：useEditor 自身在 strict double-invoke 下会创建两次实例，
 * 内部已 keep-alive，无需特殊处理。
 */
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, forwardRef } from "react";

import { useSettings } from "@/state/settings";
import { useWorkspace } from "@/state/workspace";

import { Crepe } from "@milkdown/crepe";
import { Milkdown, MilkdownProvider, useEditor } from "@milkdown/react";
import { listenerCtx } from "@milkdown/kit/plugin/listener";
import { commandsCtx, prosePluginsCtx } from "@milkdown/kit/core";
import {
  clearTextInCurrentBlockCommand,
  codeBlockSchema,
  setBlockTypeCommand,
} from "@milkdown/kit/preset/commonmark";
import type { MilkdownPlugin } from "@milkdown/ctx";
import { Plugin } from "@milkdown/prose/state";
import type { EditorView } from "@milkdown/prose/view";

import { runSqlPlugins } from "./runsql";
import { runAllBlocks, type RunAllOutcome } from "./runsql/execution";
import {
  clearActiveEditorView,
  setActiveEditorView,
} from "./active-editor";
import {
  MERMAID_LANGUAGE,
  RUNSQL_LANGUAGE,
} from "./runsql/codeblock-nodeview";
import {
  clearRunContext,
  setRunContext,
  updateRunContextNote,
} from "./runsql/run-context";
import { HEADING_SLUG_ATTR, headingAnchorPlugin } from "./heading-anchor";
import { recallScroll, rememberScroll } from "./scroll-memory";
import { wikiLinkPlugins } from "./wiki";
import {
  buildAttachmentFileName,
  cacheBlob,
  getImageObjectURL,
  resolveImageSrc,
} from "./image-assets";
import {
  LIST_BULLET_ICON,
  LIST_CHECKBOX_CHECKED_ICON,
  LIST_CHECKBOX_UNCHECKED_ICON,
} from "./list-item-icons";
import { ImagePreviewOverlay } from "./image-assets/preview-overlay";
import { joinFrontmatter, splitFrontmatter } from "@/core/markdown";
import {
  buildLineMap,
  resolveReveal,
  searchHighlightPlugin,
  type LineMap,
  type RevealLoc,
} from "./search";
import {
  clearActiveReveal,
  FindBar,
  revealRange,
  setActiveReveal,
  useFindState,
} from "./find-in-file";

// Crepe 内置 frame 主题（@milkdown/crepe/theme/frame.css）会把 14 个 --crepe-color-* token
// 硬编码写到 .milkdown 上（白底 / 黑字 / Noto Serif），特异性高于外层 host，会反向覆盖
// 我们的 shadcn 映射。所以只引 common/style.css（结构性 reset/toolbar/block-edit/...，
// 只读变量、不写变量），主题变量与字体由 ./milkdown-editor.css 自接。
import "@milkdown/crepe/theme/common/style.css";
import "./milkdown-editor.css";

interface MilkdownEditorProps {
  path: string;
  initialRaw: string;
  /**
   * 当前文档对应的连接名（已应用「frontmatter → 第一个连接」兜底逻辑，由
   * EditorView 统一解析）。null 表示没有任何可用连接。RunContext 直接用这个值，
   * 不再在编辑器内二次解析 frontmatter，保证 picker 显示与执行态一致。
   */
  connectionName: string | null;
  onDirtyChange?: (dirty: boolean) => void;
  onPersist?: (next: string) => Promise<void> | void;
}

export interface MilkdownEditorHandle {
  runAllBlocks: () => Promise<RunAllOutcome>;
}

const PERSIST_DEBOUNCE_MS = 800;
/** TOC 点击 / 锚点跳转后给目标 heading 的 800ms flash 高亮时长。 */
const REVEAL_FLASH_MS = 800;

/**
 * Crepe `image-block` / `image-inline` 的 `onUpload` 接管点：把粘贴 / 拖拽 /
 * 工具栏选择的图片文件写到 vault `<note-stem>.assets/` 目录，并返回相对 note
 * 的 POSIX 路径，让 markdown 序列化保持纯净（`![...](report.assets/foo.png)`）。
 *
 * 写盘失败 / vault 缺失时返回 null；调用方会回退成 `URL.createObjectURL(file)`，
 * 至少视觉上仍可见，避免吃掉用户操作。同时把 blob 写进 image-cache，第一次
 * 渲染就能直接命中 blob URL，省一次 IPC binary read。
 */
async function uploadImageToVault(
  file: File,
  notePath: string,
): Promise<string | null> {
  const vaultPath = useWorkspace.getState().vaultPath;
  if (!vaultPath) return null;
  if (!file.type.startsWith("image/")) return null;

  let buf: ArrayBuffer;
  try {
    buf = await file.arrayBuffer();
  } catch (err) {
    console.error("[stela] image upload: read file failed", err);
    return null;
  }
  const bytes = new Uint8Array(buf);
  // chunked 转 base64，避免 String.fromCharCode 栈溢出
  const CHUNK = 0x8000;
  let bin = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  const base64 = btoa(bin);

  const fileName = buildAttachmentFileName({
    rawName: file.name,
    mime: file.type,
  });
  try {
    const saved = await window.stela.vault.saveAttachment(
      vaultPath,
      notePath,
      fileName,
      base64,
    );
    // 把刚拿到的 bytes 直接灌进 image-cache，proxyDomURL 第一次访问就命中
    const blob = new Blob([bytes], {
      type: file.type || "application/octet-stream",
    });
    cacheBlob(saved.absPath, blob);
    return saved.relPath;
  } catch (err) {
    console.error("[stela] image upload: save attachment failed", err);
    return null;
  }
}

// Slash 菜单里「执行 SQL」项的图标。Crepe 的 slash 菜单 icon 要求 HTML string（内联 SVG），
// 避免再引入 react-dom/server 渲染 JSX，所以直接硬编码 database-zap 图标（lucide 同款）。
const RUNSQL_SLASH_ICON = `
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <ellipse cx="12" cy="5" rx="9" ry="3"/>
    <path d="M3 5V19A9 3 0 0 0 15 21.84"/>
    <path d="M21 5V8"/>
    <path d="M21 12L18 17H22L19 22"/>
    <path d="M3 12A9 3 0 0 0 14.59 14.87"/>
  </svg>
`;

// 与 RUNSQL_SLASH_ICON 同一套风格，lucide `workflow` 图标。
const MERMAID_SLASH_ICON = `
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect width="8" height="8" x="3" y="3" rx="2"/>
    <path d="M7 11v4a2 2 0 0 0 2 2h4"/>
    <rect width="8" height="8" x="13" y="13" rx="2"/>
  </svg>
`;

/**
 * CSS selector 安全转义。优先使用原生 `CSS.escape`（浏览器内置），
 * 兼容性兜底是手写的最小转义（空格、引号、反斜杠）。
 */
function cssEscape(value: string): string {
  const fn = (globalThis as { CSS?: { escape?: (v: string) => string } }).CSS
    ?.escape;
  if (fn) return fn.call((globalThis as { CSS?: unknown }).CSS, value);
  return value.replace(/["\\]/g, (m) => `\\${m}`);
}

/**
 * 把 store 里的 `PendingReveal` 翻译成 locator 认的 `RevealLoc`。
 * 优先级：keyword + nthInFile > slug > line。三条都缺则返回 null。
 */
function pendingRevealToLoc(
  pending: {
    keyword?: string;
    nthInFile?: number;
    caseSensitive?: boolean;
    slug?: string;
    line?: number;
    column?: number;
  },
  frontmatterLineCount: number,
): RevealLoc | null {
  if (
    pending.keyword &&
    pending.keyword.length > 0 &&
    pending.nthInFile !== undefined
  ) {
    return {
      kind: "keyword",
      keyword: pending.keyword,
      nthInFile: pending.nthInFile,
      caseSensitive: pending.caseSensitive ?? false,
    };
  }
  if (pending.slug) {
    return { kind: "slug", slug: pending.slug };
  }
  if (pending.line !== undefined) {
    const bodyLine = Math.max(1, pending.line - frontmatterLineCount);
    return {
      kind: "line",
      bodyLine,
      bodyColumn: pending.column,
    };
  }
  return null;
}

const MilkdownView = forwardRef<MilkdownEditorHandle, MilkdownEditorProps>(
  function MilkdownView(
    {
      path,
      initialRaw,
      connectionName,
      onDirtyChange,
      onPersist,
    },
    ref,
  ) {
  // 把 frontmatter 剥掉，editor 只接收 body
  const { frontmatter, body } = useMemo(
    () => splitFrontmatter(initialRaw),
    [initialRaw],
  );
  const initialBody = body;

  // 订阅全局 editorWidth 设置；切换立即通过 data-editor-width 反映到 DOM，不走
  // 重挂载——CSS 只改 max-width/padding，既不动 CM 实例也不丢光标。
  const editorWidth = useSettings((s) => s.settings.ui.editorWidth);

  const dirtyRef = useRef(false);
  const lastPersistedBodyRef = useRef(body);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);

  // 「真用户输入」闸：Crepe / Milkdown / RunSQL NodeView 在 mount 完成后会异步
  // 发起带 docChanged 的 transaction（NodeView 装饰、placeholder、内部 normalize），
  // listener.markdownUpdated 200ms debounce 后会把它当成"用户编辑"通知出去，触发
  // setDirty(true) → 自动 promote ephemeral tab → 800ms debounce 后 onPersist 把
  // 文件悄悄改写。我们用 host DOM 上的真实输入事件（keydown / input / paste /
  // cut / drop / compositionstart）作为"用户确实编辑过"的信号；在第一个真用户
  // 输入到来之前，markdownUpdated 一律视为 programmatic normalization 吸收掉
  // （只更新 lastPersistedBodyRef baseline，不 dirty 不 persist）。
  const userInteractedRef = useRef(false);

  // frontmatter 占用的行数：把 hit.line（全文档 1-based）折算成 body 行号时要减掉
  const frontmatterLineCount = useMemo(
    () => (frontmatter ? frontmatter.split("\n").length - 1 : 0),
    [frontmatter],
  );

  const pendingReveal = useWorkspace((s) => s.pendingReveal);
  const consumeReveal = useWorkspace((s) => s.consumeReveal);

  // PM 主路径需要的两个 ref：
  //   viewRef     —— 通过自定义 prose 插件的 view() 钩子捕获到的 EditorView 实例；
  //   lineMapRef  —— 由 [./search/source-map.ts](./search/source-map.ts) 构建，
  //                  把 body 源码行号映射到 PM 顶层 block 起始 pos。仅在 view 就绪 +
  //                  initialRaw 变化时重算；编辑中会过期，主路径（keyword+nthInFile）
  //                  不依赖它，所以可以接受。
  const viewRef = useRef<EditorView | null>(null);
  const lineMapRef = useRef<LineMap | null>(null);

  // EditorView 就绪状态。Milkdown / Crepe 是异步初始化的（Crepe.create() 返回
  // Promise，useEditor 内部 await）——文件从未打开过时，pendingReveal effect 第一
  // 次跑通常 view 还没 mount 完。viewReady 由 prose 插件 view() 钩子翻成 true，
  // reveal effect 依赖它，view 就绪后会再跑一次自然把 pending 消费掉。
  //
  // 旧实现里走的 rAF 兜底（rAF 内若 view 仍未就绪就 consumeReveal() 放弃）会在
  // 未打开过的文件上稳定丢失定位；这里改成"等到 ready 再做"的状态机。
  const [viewReady, setViewReady] = useState(false);

  useImperativeHandle(
    ref,
    () => ({
      runAllBlocks: async () => {
        const view = viewRef.current;
        if (!view) {
          return { total: 0, ran: 0, failed: 0, messages: ["编辑器尚未就绪"] };
        }
        return runAllBlocks(view);
      },
    }),
    [viewReady],
  );

  // 所有 active 高亮 / flash 副作用都封装在 RevealHandle 内（[./find-in-file/reveal.ts]），
  // 由模块级单例 setActiveReveal/clearActiveReveal 管理。MilkdownEditor 这里只
  // 负责 unmount 时调一次 clear，避免泄漏。
  useEffect(() => clearActiveReveal, []);

  // 把 callback 用 ref 锁住，避免每次 props 变化都重新装 listener
  const onDirtyRef = useRef(onDirtyChange);
  const onPersistRef = useRef(onPersist);
  useEffect(() => {
    onDirtyRef.current = onDirtyChange;
    onPersistRef.current = onPersist;
  });

  useEditor((root) => {
    const crepe = new Crepe({
      root,
      defaultValue: initialBody,
      features: {
        // 关闭 Crepe 自带的 Vue NodeView，自家 NodeView 来接
        [Crepe.Feature.CodeMirror]: false,
        // 暂不启用 LaTeX、TopBar，体感更接近"简洁笔记"
        [Crepe.Feature.Latex]: false,
        [Crepe.Feature.TopBar]: false,
      },
      featureConfigs: {
        [Crepe.Feature.BlockEdit]: {
          // 在 Advanced 分组追加「执行 SQL」+「Mermaid 图表」两项，分别以
          // runsql / mermaid 作为 code_block 的 language attr。
          buildMenu: (builder) => {
            try {
              const advanced = builder.getGroup("advanced");
              // label 内联英文关键词：Crepe slash 过滤只按 label.toLowerCase().includes()
              // 匹配（无独立 keywords 字段），把 "sql / run / runsql" 塞进 label，
              // 输入 `/sql`、`/run`、`/runsql` 都能秒选中这一项。
              advanced.addItem("runsql", {
                label: "执行 SQL · runsql / run query",
                icon: RUNSQL_SLASH_ICON,
                onRun: (ctx) => {
                  const commands = ctx.get(commandsCtx);
                  const codeBlock = codeBlockSchema.type(ctx);
                  commands.call(clearTextInCurrentBlockCommand.key);
                  commands.call(setBlockTypeCommand.key, {
                    nodeType: codeBlock,
                    attrs: { language: RUNSQL_LANGUAGE },
                  });
                },
              });
              advanced.addItem("mermaid", {
                label: "Mermaid 图表",
                icon: MERMAID_SLASH_ICON,
                onRun: (ctx) => {
                  const commands = ctx.get(commandsCtx);
                  const codeBlock = codeBlockSchema.type(ctx);
                  commands.call(clearTextInCurrentBlockCommand.key);
                  commands.call(setBlockTypeCommand.key, {
                    nodeType: codeBlock,
                    attrs: { language: MERMAID_LANGUAGE },
                  });
                },
              });
            } catch (err) {
              console.warn("[stela] slash addItem failed", err);
            }
          },
        },
        // Crepe 默认启用 @milkdown/plugin-upload，会拦截 paste/drop 调用
        // `imageBlockConfig.onUpload(file)` 拿 src，再插入 image-block 节点。
        // 我们在这里把 onUpload 接管，写到 vault `<note-stem>.assets/` 并返回
        // 相对路径，markdown 序列化就是干净的 `![](report.assets/foo.png)`。
        // proxyDomURL 把这个相对路径在 DOM 层翻译成 blob URL，绕过 CSP 对
        // file:// / http:// 相对资源的限制。
        [Crepe.Feature.ImageBlock]: {
          onUpload: async (file: File) =>
            uploadImageToVault(file, path).then(
              (rel) => rel ?? URL.createObjectURL(file),
            ),
          proxyDomURL: async (url: string) => {
            const ws = useWorkspace.getState();
            const abs = resolveImageSrc(url, path, ws.vaultPath);
            if (!abs) return url;
            try {
              return await getImageObjectURL(abs);
            } catch (err) {
              console.warn("[stela] image load failed", url, err);
              return url;
            }
          },
        },
        [Crepe.Feature.ListItem]: {
          bulletIcon: LIST_BULLET_ICON,
          checkBoxCheckedIcon: LIST_CHECKBOX_CHECKED_ICON,
          checkBoxUncheckedIcon: LIST_CHECKBOX_UNCHECKED_ICON,
        },
      },
    });

    crepe.editor.use(runSqlPlugins);
    crepe.editor.use(headingAnchorPlugin);
    crepe.editor.use(wikiLinkPlugins);
    crepe.editor.use(searchHighlightPlugin);

    // 视图捕获插件：闭包持有本组件的 viewRef / lineMapRef，PM `view()` 钩子触发后
    // 把当前 EditorView 暂存到 ref；同时立即基于 initialBody 构建 LineMap。
    // 必须用 prosePluginsCtx + 闭包写法（而非 $prose），因为 $prose 是全局单例，
    // 没法绑到具体的 React 组件实例。Plugin spec 命名为 capturePluginSpec 是为了
    // 让 cleanup 阶段从 prosePluginsCtx 里把它精确摘掉，避免热更新 / StrictMode
    // double-invoke 时累积。
    const capturePluginSpec = new Plugin({
      view(editorView) {
        viewRef.current = editorView;
        setActiveEditorView(editorView);
        try {
          lineMapRef.current = buildLineMap(initialBody, editorView);
        } catch (err) {
          console.warn("[stela] buildLineMap failed at mount", err);
          lineMapRef.current = null;
        }
        // 通知 reveal effect view 已就绪。setViewReady 是 useState 返回的稳定
        // 引用，可以安全跨闭包使用；不需要 setViewReadyRef 兜底。
        setViewReady(true);
        return {
          destroy: () => {
            if (viewRef.current === editorView) {
              viewRef.current = null;
            }
            clearActiveEditorView(editorView);
            lineMapRef.current = null;
            setViewReady(false);
          },
        };
      },
    });
    const viewCapturePlugin: MilkdownPlugin = (ctx) => {
      ctx.update(prosePluginsCtx, (plugins) => plugins.concat(capturePluginSpec));
      return () => {
        return () => {
          ctx.update(prosePluginsCtx, (plugins) =>
            plugins.filter((p) => p !== capturePluginSpec),
          );
        };
      };
    };
    crepe.editor.use(viewCapturePlugin);

    crepe.on((api) => {
      api.markdownUpdated((_ctx, markdown) => {
        const nextRaw = joinFrontmatter(frontmatter, markdown);
        updateRunContextNote(path, nextRaw);
        if (markdown === lastPersistedBodyRef.current) return;
        // 用户从未真正动过键盘/IME/粘贴 → 视为 mount 后的 programmatic
        // normalization（如 NodeView 装饰、CodeMirror 子编辑器初始化等）。
        // 把 baseline 拨到当前 markdown，吸收掉这次"伪 dirty"，避免 ephemeral
        // tab 被错误 promote、避免文件被悄悄改写。
        if (!userInteractedRef.current) {
          lastPersistedBodyRef.current = markdown;
          return;
        }
        if (!dirtyRef.current) {
          dirtyRef.current = true;
          onDirtyRef.current?.(true);
        }
        if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = setTimeout(() => {
          debounceTimerRef.current = null;
          lastPersistedBodyRef.current = markdown;
          void Promise.resolve(onPersistRef.current?.(nextRaw))
            .then(() => {
              dirtyRef.current = false;
              onDirtyRef.current?.(false);
            })
            .catch((err: unknown) => {
              console.error("[stela] persist failed", err);
            });
        }, PERSIST_DEBOUNCE_MS);
      });
    });

    // listener 已经被 Crepe builder 内部 use 过；这里再 ensure 一次确保 ctx 里有
    crepe.editor.config((ctx) => {
      ctx.get(listenerCtx);
    });

    return crepe;
  }, [path]);

  // 把 EditorView 解析过（含「第一个连接」兜底）的 connectionName 推到 RunContext
  // 单例，供 NodeView runBlock 消费。不再在本组件内二次解析 frontmatter：兜底
  // 规则统一放在 EditorView，避免两处逻辑漂移。
  useEffect(() => {
    setRunContext({ path, connectionName, noteMarkdown: initialRaw });
    return () => {
      clearRunContext(path);
    };
  }, [path, connectionName, initialRaw]);


  // 卸载时把未提交的 debounce 立即吐回，避免切 tab 丢字
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
  }, []);

  // 给 host 挂真用户输入监听器（capture 阶段，确保先于 PM/CM 内部消费），
  // 第一个事件到来即标记 userInteractedRef.current = true，markdownUpdated
  // 闸门由此打开。RunSQL CodeMirror NodeView 内部的输入也会冒泡到 host，
  // 所以一份 listener 同时覆盖 PM 主编辑区和 CM 子编辑器。
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onUserInput = () => {
      userInteractedRef.current = true;
    };
    const events = [
      "keydown",
      "input",
      "beforeinput",
      "paste",
      "cut",
      "drop",
      "compositionstart",
    ] as const;
    for (const ev of events) {
      host.addEventListener(ev, onUserInput, { capture: true });
    }
    return () => {
      for (const ev of events) {
        host.removeEventListener(ev, onUserInput, { capture: true });
      }
    };
  }, []);

  // pendingReveal 消费：locator + searchHighlightPlugin 主导，全程在 PM pos 域内。
  //
  // 工作流：
  //   1. 把 pendingReveal 转成 RevealLoc（keyword+nthInFile / slug / line+column）
  //   2. resolveReveal 拿到 { from, to, blockPos, kind }；keyword 数量不足 → 自动
  //      回退到 line 路径（详见下方"detail 兜底"）
  //   3. dispatch tr.setSelection(Selection.near(...)).scrollIntoView() —— 由 PM 自己
  //      把目标 pos 滚到视口（精确，不需要 rAF + getClientRects）
  //   4. dispatch setSearch meta，通知 search-highlight-plugin 重画 Decoration
  //   5. 给 active block 的 DOM 加 stela-reveal-flash class，800ms 后移除
  //   6. SEARCH_HL_MS 超时后 dispatch clearSearch 把 Decoration 清掉
  //
  // 注意：scrollIntoView 用 PM 的 tr.scrollIntoView()，不是 DOM scrollIntoView。
  // 走 PM 路径有两个好处：①不依赖 element.scrollIntoView 的 smooth 动画期间坐标；
  // ②自动用 PM 自己的视口定义（更准确处理嵌套滚动容器）。
  useEffect(() => {
    if (!pendingReveal) return;
    if (pendingReveal.path !== path) return;

    // view 还没就绪 → 不消费、不报错。viewReady 翻 true 后 effect 会自然重跑。
    // 这里专门治"搜索点击未打开过的文件，editor 还在异步 mount 时 reveal 被丢"
    // 的 race——pendingReveal 一直留在 store 里，等到下一次 effect 触发再执行。
    if (!viewReady) return;
    if (!viewRef.current) return;

    const reveal = pendingReveal;

    // 再等几帧 layout 沉降。viewReady 翻 true 的瞬间 PM `EditorView` 已构造完成，
    // 但首屏 paint / NodeView 内部的异步 render（CodeBlockNodeView 的
    // `createRoot(...).render(<BlockResult/>)`、Mermaid 预览、heading-anchor 装饰等）
    // 还没跑完。此时直接调 `view.coordsAtPos(targetPos)` 经常拿到 (0,0,0,0)，PM 据此
    // 判定"目标已在视口"，scrollIntoView 被吞——肉眼看就是"完全没滚"。已打开过的
    // 文件不出现这个问题，因为 layout 早就稳定了。
    //
    // 解法：double rAF 把 reveal 主体挪到 layout 真正稳定后再执行。第一帧 rAF 等
    // React commit 后的 layout，第二帧 rAF 等 NodeView 内部异步 render 后的二次
    // layout。开销几乎可以忽略，但能稳住"未打开过的文件搜索点击不滚动"这个 race。
    let cancelled = false;
    let raf2: number | null = null;
    const raf1 = requestAnimationFrame(() => {
      if (cancelled) return;
      raf2 = requestAnimationFrame(() => {
        if (cancelled) return;
        runReveal();
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf1);
      if (raf2 !== null) cancelAnimationFrame(raf2);
    };

    function runReveal() {
      const view = viewRef.current;
      if (!view) {
        consumeReveal();
        return;
      }

      const loc = pendingRevealToLoc(reveal, frontmatterLineCount);
      if (!loc) {
        consumeReveal();
        return;
      }

      let range = resolveReveal(view, lineMapRef.current, loc);

      // detail / RunSQL 兜底：keyword 主路径找不到第 N 个命中（典型场景：vault 命中
      // 落在 `<detail>` 行，被 remark-detail-merge 合并进 code_block.attrs，PM doc
      // 里看不到这段文本），改走 line 兜底，把整个 code_block 当作 active block。
      if (!range && loc.kind === "keyword" && reveal.line !== undefined) {
        const bodyLine = Math.max(1, reveal.line - frontmatterLineCount);
        range = resolveReveal(view, lineMapRef.current, {
          kind: "line",
          bodyLine,
          bodyColumn: reveal.column,
        });
      }

      if (!range) {
        consumeReveal();
        return;
      }

      // 把所有副作用收敛到 [./find-in-file/reveal.ts]：选区 + DOM scrollIntoView +
      // CodeBlock CM 桥接 + PM Decoration + flash。模块单例 setActiveReveal 会在
      // 安装新 handle 之前 cleanup 旧 handle，避免来自 FindBar 与 sidebar 双路径
      // reveal 并发时的高亮冲突。
      //
      // 如果此时 FindBar 是开着的，我们用它持有的 keyword + caseSensitive 接管，
      // 让 sidebar 跳过来后高亮能持续显示而不是 3 秒淡出；否则按"短暂闪一下后清"
      // 的旧体感（hlTimeoutMs 默认 3s）。flash 只在外部 reveal 触发时给——FindBar
      // 自己 next/prev 太频繁不闪。
      const findIsOpen = useFindState.getState().isOpen;
      const findKeyword = useFindState.getState().keyword;
      const findCS = useFindState.getState().caseSensitive;
      const useFindHighlight =
        findIsOpen && findKeyword.length > 0 && findKeyword === reveal.keyword;
      const handle = revealRange(view, range, {
        keyword: reveal.keyword ?? "",
        caseSensitive: useFindHighlight ? findCS : reveal.caseSensitive,
        hlTimeoutMs: useFindHighlight ? -1 : 3000,
        flash: true,
      });
      setActiveReveal(handle);
      consumeReveal();
    }
  }, [
    pendingReveal,
    path,
    viewReady,
    frontmatterLineCount,
    consumeReveal,
  ]);

  // initialRaw 变化（外部 reload / 切换 tab 后重读）→ view 内容已被 Milkdown 重置，
  // 此时需要重建 LineMap，否则 line 路径会用旧 mapping。
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    try {
      lineMapRef.current = buildLineMap(initialBody, view);
    } catch (err) {
      console.warn("[stela] buildLineMap rebuild failed", err);
      lineMapRef.current = null;
    }
  }, [initialBody]);

  // ---- 滚动位置记忆：持续把 host.scrollTop 写进按 path 的模块级缓存 ----
  // 用 rAF 节流的 scroll 监听持续刷新缓存，这样缓存永远是最新值，unmount 时不必
  // 再读已可能脱离文档的 DOM（脱离 document 的元素 scrollTop 会读成 0）。
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let rafId: number | null = null;
    const flush = () => {
      rafId = null;
      rememberScroll(path, host.scrollTop);
    };
    const onScroll = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(flush);
    };
    host.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      host.removeEventListener("scroll", onScroll);
    };
  }, [path]);

  // ---- 滚动位置恢复：view 就绪后把缓存的 scrollTop 还原回去 ----
  // 优先级低于 pendingReveal：若本次打开带搜索 / 锚点跳转请求（reveal effect 会主动
  // 滚到目标），跳过恢复，避免和跳转打架。double rAF 等 layout / NodeView 异步 render
  // 沉降后再设，和 reveal 同款时序，否则 scrollHeight 还没撑开会被截断。
  useEffect(() => {
    if (!viewReady) return;
    if (pendingReveal && pendingReveal.path === path) return;
    const host = hostRef.current;
    if (!host) return;
    const target = recallScroll(path);
    if (target === undefined || target <= 0) return;

    let cancelled = false;
    let raf2: number | null = null;
    const raf1 = requestAnimationFrame(() => {
      if (cancelled) return;
      raf2 = requestAnimationFrame(() => {
        if (cancelled) return;
        const max = host.scrollHeight - host.clientHeight;
        host.scrollTop = max > 0 ? Math.min(target, max) : 0;
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf1);
      if (raf2 !== null) cancelAnimationFrame(raf2);
    };
    // 只在首次 view 就绪时恢复一次；path 切换会整体重挂，effect 自然重跑。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewReady, path]);

  // FindBar 视觉 / fade 联动：host 上挂 data-find-bar-open，CSS 据此关闭 search-hit
  // 的 fade-out 动画（见 milkdown-editor.css §find-bar）。
  const findIsOpen = useFindState((s) => s.isOpen);

  // capture-phase keydown：在 PM / CM 自家 keymap 之前先看到 Cmd+F / Cmd+Alt+F / Esc，
  // 统一翻成 FindBar 的 open / close。
  //   - Mod+F                  → open("find")，PM/CM 看不到这次按键，避免内嵌 CM
  //                              触发自家 @codemirror/search panel；
  //   - Mod+Alt+F              → open("replace")；
  //   - Mod+Shift+F            → **不**拦截，让 AppShell 的全局 hotkey 处理（侧栏 vault 搜索）；
  //   - Escape（FindBar 打开时）→ 关掉 bar，把焦点还给 PM。bar 没开时让事件继续冒泡。
  //
  // 必须用 `e.code === "KeyF"` 比对而不是 `e.key === "f"`：macOS 上 `Option+F` 让
  // e.key 变成组合字符 `"ƒ"`，e.key 比对会让 Cmd+Alt+F 永远 miss。e.code 是物理键
  // 名，不受 modifier 翻译影响。
  const onHostKeyDownCapture = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const mod = e.metaKey || e.ctrlKey;
      const isF = e.code === "KeyF";
      if (mod && isF && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        useFindState.getState().open(e.altKey ? "replace" : "find");
        return;
      }
      if (e.key === "Escape" && useFindState.getState().isOpen) {
        e.preventDefault();
        e.stopPropagation();
        useFindState.getState().close();
        clearActiveReveal();
        viewRef.current?.focus();
        return;
      }
    },
    [],
  );

  // 布局：横向 flex 行。左边 .stela-editor-main 是 flex-1 的相对定位主列（滚动 host
  // + overlay 们都在里面）。右边 DocumentTocRail 是常驻的极简目录刻度条（固定 ~20px
  // 占位列），与主列内 right:0 的滚动条物理分离、永不重叠——这是把目录放右侧又不和
  // 滚动条打架的关键。
  //
  // HostScrollbar / FindBar / ImagePreviewOverlay 都是 host 的**兄弟**而非子——
  // host 自身是滚动容器，absolute 子元素会随滚动一起向上位移（被滚出视口），所以
  // 必须挂到不滚动的父（.stela-editor-main 这个 relative div）里，相对它定位才不会
  // 跟着滚。FindBar 同款约束：相对该 relative 父定位（top:8px / right:16px），永远
  // 悬停在编辑器视口右上角。
  return (
    <div className="stela-editor-layout">
      <div className="stela-editor-main">
        <div
          ref={hostRef}
          className="stela-milkdown-host"
          data-editor-width={editorWidth}
          // 给 wiki-link NodeView 提供"当前文档绝对路径"。NodeView 通过
          // `view.dom.closest('[data-stela-note-path]')` 读这个属性，作为
          // [[../foo]] / [[./foo]] 这类相对 wiki link 的 basePath。
          data-stela-note-path={path}
          data-find-bar-open={findIsOpen ? "true" : undefined}
          // capture-phase keydown：在 PM/CM 的 keymap 之前拦掉 Cmd+F / Cmd+Alt+F /
          // Esc，统一翻成 FindBar 的 open / close。否则 CM 内 Cmd+F 会进它自家的
          // search panel，PM 的 Esc 会移除 mark / 失焦，体感割裂。
          onKeyDownCapture={onHostKeyDownCapture}
        >
          <Milkdown />
        </div>
        <HostScrollbar hostRef={hostRef} />
        <FindBar viewRef={viewRef} />
        <ImagePreviewOverlay hostRef={hostRef} />
      </div>
      <DocumentTocRail hostRef={hostRef} />
    </div>
  );
});

/**
 * 自定义滚动条 overlay。
 *
 * 背景：macOS WKWebView 对 `::-webkit-scrollbar` 自定义支持极差——"始终"模式
 * 渲染透明条、"自动/滚动时"停止滚动立刻淡出——用户反馈"右侧看不到滚动条"就
 * 是这个问题。我们把原生条 `scrollbar-width: none` + `::-webkit-scrollbar { display: none }`
 * 彻底隐藏，改在此 React 组件里画一个永远可见的 thumb。
 *
 * 行为：
 *  - 内容不溢出时不渲染（避免空轨道抢视觉）
 *  - 订阅 scroll / ResizeObserver / MutationObserver，保证位置跟随
 *  - 支持鼠标拖拽 thumb（pointerdown/move/up）
 *  - thumb 最小高度 24px，避免超长文档下被压成小不点
 */
function HostScrollbar({
  hostRef,
}: {
  hostRef: React.RefObject<HTMLDivElement | null>;
}) {
  const [state, setState] = useState<{
    top: number;
    height: number;
    visible: boolean;
  }>({ top: 0, height: 0, visible: false });
  const thumbRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let rafId: number | null = null;
    let moThrottleTimer: ReturnType<typeof setTimeout> | null = null;
    const update = () => {
      rafId = null;
      const sh = host.scrollHeight;
      const ch = host.clientHeight;
      if (sh <= ch + 1) {
        setState((s) => (s.visible ? { top: 0, height: 0, visible: false } : s));
        return;
      }
      const thumbHeight = Math.max(24, (ch / sh) * ch);
      const denom = ch - thumbHeight;
      const thumbTop =
        denom <= 0 ? 0 : (host.scrollTop / (sh - ch)) * denom;
      // 跳过 1px 内的微小变化，避免 thumb 在打字过程中每帧都 setState 触发 React 协调
      setState((s) => {
        if (
          s.visible &&
          Math.abs(s.top - thumbTop) < 1 &&
          Math.abs(s.height - thumbHeight) < 1
        ) {
          return s;
        }
        return { top: thumbTop, height: thumbHeight, visible: true };
      });
    };
    const schedule = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(update);
    };

    // 内容变更（typing / 结果表渲染 / 图片异步加载）走的 MutationObserver 在大文档
    // 里非常吵：ProseMirror / CodeMirror 每次按键都会切换 active-line class、调整
    // selection 位置，对 .milkdown 子树派发上百条记录。早期实现里我们直接 schedule
    // → rAF → setState，每帧都跑一遍 scrollHeight/clientHeight 测量，是输入路径
    // 上的隐性开销。
    //
    // 修法：MO 路径加 ~120ms 节流（首次立即响应、后续在尾沿合并），并把观察范围
    // 收紧——只看 childList + characterData，不再监听 attributes / subtree 全量。
    // 真正影响 scrollHeight 的事件（增删段落、文本长度变化）仍能被覆盖；attribute
    // 变化（active-line、cursor 类切换）不会改变滚动尺寸，可以安全忽略。
    const scheduleThrottled = () => {
      if (moThrottleTimer !== null) return;
      // leading edge：第一次到来立即跑一帧，保证用户敲下第一字时滚动条同步
      schedule();
      moThrottleTimer = setTimeout(() => {
        moThrottleTimer = null;
        // trailing edge：把窗口期内累积的变化合并成一次 update
        schedule();
      }, 120);
    };

    update();
    host.addEventListener("scroll", schedule, { passive: true });
    const ro = new ResizeObserver(schedule);
    ro.observe(host);
    const mo = new MutationObserver(scheduleThrottled);
    mo.observe(host, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      if (moThrottleTimer !== null) clearTimeout(moThrottleTimer);
      host.removeEventListener("scroll", schedule);
      ro.disconnect();
      mo.disconnect();
    };
  }, [hostRef]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const host = hostRef.current;
      const thumb = thumbRef.current;
      if (!host || !thumb) return;
      e.preventDefault();
      draggingRef.current = true;
      thumb.dataset.dragging = "true";
      const track = thumb.parentElement as HTMLElement;
      const trackRect = track.getBoundingClientRect();
      const thumbRect = thumb.getBoundingClientRect();
      const offsetY = e.clientY - thumbRect.top;

      const onMove = (ev: PointerEvent) => {
        const sh = host.scrollHeight;
        const ch = host.clientHeight;
        const thumbH = thumbRect.height;
        const y = ev.clientY - trackRect.top - offsetY;
        const denom = ch - thumbH;
        const ratio =
          denom <= 0 ? 0 : Math.max(0, Math.min(1, y / denom));
        host.scrollTop = ratio * (sh - ch);
      };
      const onUp = () => {
        draggingRef.current = false;
        if (thumb) delete thumb.dataset.dragging;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [hostRef],
  );

  if (!state.visible) return null;

  return (
    <div className="stela-host-scrollbar" aria-hidden>
      <div
        ref={thumbRef}
        className="stela-host-scrollbar__thumb"
        style={{ top: state.top, height: state.height }}
        onPointerDown={onPointerDown}
      />
    </div>
  );
}

export const MilkdownEditor = forwardRef<MilkdownEditorHandle, MilkdownEditorProps>(
  function MilkdownEditor(props, ref) {
    return (
      <MilkdownProvider>
        <MilkdownView {...props} ref={ref} />
      </MilkdownProvider>
    );
  },
);

interface TocItem {
  /** 1-6，对应 h1-h6 */
  level: number;
  /** 显示文本 */
  text: string;
  /** GitHub 风格 slug，由 headingAnchorPlugin 写到 DOM 的 data-heading-slug 上 */
  slug: string;
  /** 同 slug 在文档内的出现序号（含本身），用于在 React 列表里做稳定 key——
   *  buildSlugs 已对重复名做 -1/-2 后缀，所以理论上 slug 已唯一；这里再叠一层
   *  序号兜底极端 race（slug 还没分配完时的中间帧）。 */
  occurrence: number;
}

/**
 * 当前活跃 heading 判定的视口顶部偏移。值越大越靠下的标题才会被高亮，
 * 80px 与编辑器顶部 padding 大致同节奏，能让屏幕顶端那个标题正好高亮。
 */
const TOC_ACTIVE_OFFSET_PX = 80;

/**
 * 目录停靠栏的展开/收起会话偏好（模块级，不写盘）。切文件会重挂载 DocumentTocRail，
 * 用它把上次的选择带到下一个文件，避免每次都弹回默认展开。
 */
let tocDockCollapsed = false;

/**
 * 右侧文档目录停靠栏（DocumentTocRail）。
 *
 * 形态：编辑器最右侧的常驻停靠栏。文档有标题时默认展开为 ~260px 的目录列，
 * 作为 .stela-editor-layout 的右侧 flex 占位列，**挤占**宽度（正文随之收窄居中）
 * 而非浮层遮挡；与主列内 right:0 的滚动条物理分离、永不重叠。可点收起按钮折成
 * 一条 ~32px 窄条（只留一颗展开按钮），需要时再展开。
 *
 * 收起偏好：用模块级 `tocDockCollapsed` 记住本次会话内的展开/收起选择，切文件
 * 重挂载后仍保持（不写盘、不进 markdown）。其余 UI 状态随重挂载重置。
 *
 * heading 数据：直接读取 host 内 `.ProseMirror` 中带有 `data-heading-slug`
 * 的 `<h1>-<h6>`（属性由 [./heading-anchor](./heading-anchor) 的 PM 插件写入）。
 * 这里**不**再独立解析 markdown / mdast，避免与 PM 真实渲染漂移。
 *
 * 滚动跟随：监听 host 的 scroll 事件，按视口顶部 ± `TOC_ACTIVE_OFFSET_PX`
 * 选最后一个滚过该偏移的标题作为 active。
 *
 * 点击跳转：把对应 heading DOM 滚到视口顶部——用固定 ~200ms 缓动自定义动画
 * （而非原生 smooth，避免长文档跳远时动画时长过长），并复用 `stela-reveal-flash`
 * 高亮效果做视觉确认。
 */
function DocumentTocRail({
  hostRef,
}: {
  hostRef: React.RefObject<HTMLDivElement | null>;
}) {
  const [items, setItems] = useState<TocItem[]>([]);
  const [activeSlug, setActiveSlug] = useState<string | null>(null);
  // 展开/收起偏好：初值取模块级会话记忆，切文件重挂载后仍保持上次选择。
  const [collapsed, setCollapsed] = useState(tocDockCollapsed);
  const containerRef = useRef<HTMLDivElement>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollAnimRef = useRef<number | null>(null);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((c) => {
      tocDockCollapsed = !c;
      return !c;
    });
  }, []);

  // ---- 1) 收集 heading：MutationObserver 节流，与 HostScrollbar 同款思路 ----
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let rafId: number | null = null;
    let throttleTimer: ReturnType<typeof setTimeout> | null = null;

    const collect = () => {
      rafId = null;
      const pm = host.querySelector(".ProseMirror");
      if (!pm) {
        setItems((prev) => (prev.length === 0 ? prev : []));
        return;
      }
      const headings = pm.querySelectorAll<HTMLElement>(
        "h1, h2, h3, h4, h5, h6",
      );
      const next: TocItem[] = [];
      const counts = new Map<string, number>();
      headings.forEach((h) => {
        const slug = h.getAttribute(HEADING_SLUG_ATTR);
        if (!slug) return;
        const level = parseInt(h.tagName.slice(1), 10);
        if (Number.isNaN(level)) return;
        const seen = counts.get(slug) ?? 0;
        counts.set(slug, seen + 1);
        next.push({
          level,
          text: (h.textContent ?? "").trim(),
          slug,
          occurrence: seen,
        });
      });
      setItems((prev) => {
        if (
          prev.length === next.length &&
          prev.every(
            (p, i) =>
              p.slug === next[i]!.slug &&
              p.text === next[i]!.text &&
              p.level === next[i]!.level &&
              p.occurrence === next[i]!.occurrence,
          )
        ) {
          return prev;
        }
        return next;
      });
    };

    const schedule = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(collect);
    };

    // 与 HostScrollbar 同样的"首沿立即响应 + 尾沿合并"节流。typing 路径上 PM 会
    // 派发大量无关 mutation（active-line class 切换、selection 偏移等），我们
    // 只关心结构性变化（增删段落、改文本、改 heading-slug 装饰）。
    const scheduleThrottled = () => {
      if (throttleTimer !== null) return;
      schedule();
      throttleTimer = setTimeout(() => {
        throttleTimer = null;
        schedule();
      }, 200);
    };

    collect();
    const mo = new MutationObserver(scheduleThrottled);
    mo.observe(host, {
      childList: true,
      subtree: true,
      characterData: true,
      // 仅监听 heading-slug 属性变化（plugin 重新计算后会重写整批），
      // 其它属性变化（光标 / hover class）不影响目录。
      attributes: true,
      attributeFilter: [HEADING_SLUG_ATTR],
    });

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      if (throttleTimer !== null) clearTimeout(throttleTimer);
      mo.disconnect();
    };
  }, [hostRef]);

  // ---- 2) active heading：scroll 时按视口顶部偏移挑最后一个滚过的标题 ----
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (items.length === 0) {
      setActiveSlug((cur) => (cur === null ? cur : null));
      return;
    }

    let rafId: number | null = null;
    const update = () => {
      rafId = null;
      const pm = host.querySelector(".ProseMirror");
      if (!pm) return;
      const headings = pm.querySelectorAll<HTMLElement>(
        "h1, h2, h3, h4, h5, h6",
      );
      const hostTop = host.getBoundingClientRect().top;
      let activeSlugLocal: string | null = null;
      headings.forEach((h) => {
        const slug = h.getAttribute(HEADING_SLUG_ATTR);
        if (!slug) return;
        const top = h.getBoundingClientRect().top - hostTop;
        if (top - TOC_ACTIVE_OFFSET_PX <= 0) activeSlugLocal = slug;
      });
      setActiveSlug((cur) =>
        cur === activeSlugLocal ? cur : activeSlugLocal,
      );
    };
    const schedule = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(update);
    };

    update();
    host.addEventListener("scroll", schedule, { passive: true });
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      host.removeEventListener("scroll", schedule);
    };
  }, [hostRef, items]);

  // ---- 3) 卸载清理 flash timer 与滚动动画帧 ----
  useEffect(() => {
    return () => {
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
      if (scrollAnimRef.current !== null) cancelAnimationFrame(scrollAnimRef.current);
    };
  }, []);

  const onClickItem = useCallback(
    (slug: string) => {
      const host = hostRef.current;
      if (!host) return;
      const pm = host.querySelector(".ProseMirror");
      if (!pm) return;
      const target = pm.querySelector<HTMLElement>(
        `[${HEADING_SLUG_ATTR}="${cssEscape(slug)}"]`,
      );
      if (!target) return;

      // 定长快速平滑滚动：原生 scrollIntoView({behavior:"smooth"}) 的时长随跳转
      // 距离增长，长文档跳很远时要"滚很久"。这里改成固定 ~200ms 缓动，无论距离
      // 远近都一样快；连点目录时打断上一次动画。
      const startTop = host.scrollTop;
      const delta =
        target.getBoundingClientRect().top - host.getBoundingClientRect().top;
      const maxTop = host.scrollHeight - host.clientHeight;
      const endTop = Math.max(0, Math.min(startTop + delta, maxTop));
      if (scrollAnimRef.current !== null) {
        cancelAnimationFrame(scrollAnimRef.current);
        scrollAnimRef.current = null;
      }
      const dist = endTop - startTop;
      if (Math.abs(dist) < 1) {
        host.scrollTop = endTop;
      } else {
        const DURATION_MS = 200;
        const t0 = performance.now();
        const step = (now: number) => {
          const p = Math.min(1, (now - t0) / DURATION_MS);
          // easeOutCubic：起步快、收尾稳
          const eased = 1 - Math.pow(1 - p, 3);
          host.scrollTop = startTop + dist * eased;
          if (p < 1) {
            scrollAnimRef.current = requestAnimationFrame(step);
          } else {
            scrollAnimRef.current = null;
          }
        };
        scrollAnimRef.current = requestAnimationFrame(step);
      }

      target.classList.add("stela-reveal-flash");
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
      flashTimerRef.current = setTimeout(() => {
        target.classList.remove("stela-reveal-flash");
        flashTimerRef.current = null;
      }, REVEAL_FLASH_MS);
      setActiveSlug(slug);
      // 停靠栏常驻，点击后不收起，方便长文档连续跳转浏览。
    },
    [hostRef],
  );

  // 没有 heading 不渲染：整列停靠栏都不占位，避免空目录还吃掉右侧宽度。
  if (items.length === 0) return null;

  // 多级标题以最浅那一级为基准，缩进从 0 开始数。文档全是 h2-h4 时，
  // h2 不会被白白缩两格。
  const minLevel = items.reduce((m, it) => Math.min(m, it.level), 6);

  // 收起态：只留一条窄条 + 展开按钮，点一下展开回目录列。
  if (collapsed) {
    return (
      <div ref={containerRef} className="stela-toc-rail" data-collapsed="true">
        <button
          type="button"
          className="stela-toc-rail__trigger"
          onClick={toggleCollapsed}
          aria-label="展开目录"
          title="展开目录"
        >
          {/* lucide list icon —— 4 条不齐的横线，远看像一份目录 */}
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <line x1="21" y1="6" x2="3" y2="6" />
            <line x1="17" y1="12" x2="3" y2="12" />
            <line x1="21" y1="18" x2="3" y2="18" />
            <line x1="13" y1="9" x2="3" y2="9" />
          </svg>
        </button>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="stela-toc-rail">
      <div className="stela-toc-rail__panel" role="navigation" aria-label="文档目录">
        <div className="stela-toc-rail__header">
          <span className="stela-toc-rail__title">目录</span>
          <button
            type="button"
            className="stela-toc-rail__collapse"
            onClick={toggleCollapsed}
            aria-label="收起目录"
            title="收起目录"
          >
            {/* lucide panel-right-close —— 向右收起的箭头 */}
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="m9 6 6 6-6 6" />
            </svg>
          </button>
        </div>
        <ul className="stela-toc-rail__list">
          {items.map((item, idx) => (
            <li
              key={`${item.slug}#${item.occurrence}#${idx}`}
              className="stela-toc-rail__item"
              data-active={activeSlug === item.slug ? "true" : undefined}
              data-level={item.level - minLevel}
            >
              <button
                type="button"
                className="stela-toc-rail__link"
                onClick={() => onClickItem(item.slug)}
                title={item.text}
              >
                {item.text || "（无标题）"}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

