/**
 * Mermaid 懒加载 + 渲染工具。
 *
 *   - 只在第一次调用 [renderMermaid](./render.ts#renderMermaid) 时动态 import
 *     `mermaid` —— 体积 ~1.5MB gz，不能进主 bundle
 *   - 全局单例 `mermaid.initialize({ startOnLoad: false, theme: "default" })`
 *   - render id 由调用方自带（需保证全局唯一），避免 mermaid 同 id 相互覆盖
 *   - parse / render 抛错时把错误信息向上抛，由 NodeView 决定是"保留上次 SVG +
 *     红色错误条"还是首次渲染的"错误态"
 *
 * 为什么不在模块顶部 `import "mermaid"`：mermaid 启动时会尝试读 DOM 与全局 fetch，
 * 在 SSR / Node 环境下会炸；而 Stela 的打包器会把顶层 import 的内容塞进初始 chunk，
 * 用户即便没有 mermaid block 也要付出 1.5MB 的下载成本。
 */

export interface MermaidApi {
  render(id: string, text: string): Promise<{ svg: string }>;
}

let mermaidPromise: Promise<MermaidApi> | null = null;

/** 懒加载 + initialize，返回单例 mermaid API。 */
export function getMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid")
      .then((mod) => {
        const mermaid = mod.default;
        mermaid.initialize({
          startOnLoad: false,
          // theme 选 default 贴 Stela 亮色主题；真要跟随 shadcn 主题变量需要自定义
          // theme variables —— 一期不做，先把"能渲染出来"落地
          theme: "default",
          securityLevel: "strict",
          fontFamily:
            "var(--font-sans, ui-sans-serif, system-ui, -apple-system, sans-serif)",
        });
        return mermaid as unknown as MermaidApi;
      })
      .catch((err: unknown) => {
        mermaidPromise = null;
        throw err;
      });
  }
  return mermaidPromise;
}

/**
 * 渲染一段 mermaid 源码成 SVG 字符串。id 由调用方自带，需保证在整个页面唯一
 * （推荐用 `mermaid-${crypto.randomUUID()}`）。
 */
export async function renderMermaid(
  id: string,
  source: string,
): Promise<string> {
  const mermaid = await getMermaid();
  const { svg } = await mermaid.render(id, source);
  return svg;
}
