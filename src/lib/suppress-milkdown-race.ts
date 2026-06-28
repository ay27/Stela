/**
 * 抑制一条特定的 Milkdown 7.20 race 错误：
 *   `MilkdownError: Context "editorView" not found, do you forget to inject it?`
 *
 * 触发链路（dev 模式偶发，prod 当前没复现）：
 *   1. `Crepe.create()` 内部 `Editor.create()` 走异步 plugin lifecycle
 *   2. EditorView 构造期间，某个 plugin 的 `view()` 函数会 dispatch 一次 transaction
 *      （比如 plugin-block-edit 注入的 id tracker）
 *   3. dispatch 触发 listener plugin 的 apply，apply 在 lodash debounce 里排了一个
 *      trailing edge timer
 *   4. timer 触发时 trailing edge serialize 当前文档为 markdown（要喂给 markdownUpdated 订阅者）
 *   5. serializer 遍历 prose doc，调每个节点 / mark 对应的 toMarkdown runner
 *   6. milkdown 内置某个 runner 调 `ctx.use(editorViewCtx)`，但此时 `editorView`
 *      还没被 inject（`Editor.create()` 整体未完成）→ 抛 `contextNotFound`
 *
 * 影响：仅 dev console 红字，编辑器实际功能不受影响（catch 之后下一帧 ctx 就 inject 完，
 * 后续 markdownUpdated 全部正常）。Milkdown 上游尚未修。
 *
 * 兜底策略：window.error 监听 → 匹配特定 message → preventDefault + 转 console.warn 记
 * 追踪。其它任何错误一律放过，不动。
 *
 * 装载位置：[src/main.tsx](../main.tsx) 在 React render 之前 install。
 */

const RACE_MESSAGE_FRAGMENT = 'Context "editorView" not found';

let installed = false;

function isRaceError(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof Error && typeof err.message === "string") {
    return err.message.includes(RACE_MESSAGE_FRAGMENT);
  }
  if (typeof err === "string") {
    return err.includes(RACE_MESSAGE_FRAGMENT);
  }
  return false;
}

export function installMilkdownRaceSuppressor(): void {
  if (installed) return;
  installed = true;

  window.addEventListener(
    "error",
    (ev) => {
      if (isRaceError(ev.error) || isRaceError(ev.message)) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        console.warn(
          "[stela] suppressed Milkdown editorView race (harmless, see lib/suppress-milkdown-race.ts)",
        );
      }
    },
    true,
  );

  window.addEventListener("unhandledrejection", (ev) => {
    if (isRaceError(ev.reason)) {
      ev.preventDefault();
      console.warn(
        "[stela] suppressed Milkdown editorView race (promise, see lib/suppress-milkdown-race.ts)",
      );
    }
  });
}
