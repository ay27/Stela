import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/globals.css";
import { installMilkdownRaceSuppressor } from "./lib/suppress-milkdown-race";

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");

// 给 <html> 标记平台，用于 frameless 窗口下条件化 CSS：
//   - mac：Sidebar header 给红绿灯留 pl-[78px]
//   - win：TabBar 右侧给 titleBarOverlay (~138px) 留出 no-drag 安全区
// 在 IDE 内是 webkit-based，navigator.platform 在 Electron 中可靠。
const ua = navigator.userAgent || "";
const platform =
  /Mac|iPhone|iPad|iPod/i.test(navigator.platform || ua)
    ? "mac"
    : /Win/i.test(navigator.platform || ua)
      ? "win"
      : "linux";
document.documentElement.dataset.platform = platform;

/**
 * 故意不包 React.StrictMode。
 *
 * 原因：Milkdown 7.20 的 useEditor 在 StrictMode 双调用 cleanup → re-mount 顺序下
 * 会触发一个内部 race —— 第二次实例在第一次的 cleanup 完成前进入 schema runner，
 * `ctx.use(editorViewCtx)` 拿不到上下文，抛
 *   `MilkdownError: Context "editorView" not found, do you forget to inject it?`
 *
 * 即便去掉 StrictMode，这个 race 在某些 dev 启动 timing 下仍会偶发出现一次（单调用
 * 也可能命中），原因见 [src/lib/suppress-milkdown-race.ts](./lib/suppress-milkdown-race.ts)
 * 的注释。所以再装一个全局 error 过滤器把这条特定 message 静音掉，避免污染 dev console。
 *
 * Milkdown 上游修复后可恢复 StrictMode 并移除 suppressor。
 */
installMilkdownRaceSuppressor();

ReactDOM.createRoot(root).render(<App />);
