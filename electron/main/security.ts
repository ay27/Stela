/**
 * Electron 安全基线。
 *
 * 参考：https://www.electronjs.org/docs/latest/tutorial/security
 *
 * 关键策略：
 * 1. 任何 webContents 创建时，禁止其它脚本注入或导航
 * 2. 拦截 window.open / target=_blank：转给 main 决定是否走系统浏览器
 * 3. 限制可加载的协议：dev 用 http://localhost:1420，prod 用 file://
 * 4. 阻止权限请求（默认全 deny）
 * 5. 阻止 webview tag（renderer 不该用）
 *
 * CSP 单独由 `applyCsp()` 在 webRequest 上注入响应头。
 */

import { app, session, shell } from "electron";

const ALLOWED_EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

const DEV_RENDERER_ORIGIN = process.env.ELECTRON_RENDERER_URL ?? "";

export function applySecurityDefaults(): void {
  app.on("web-contents-created", (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      void openExternalIfAllowed(url);
      return { action: "deny" };
    });

    contents.on("will-navigate", (event, url) => {
      const target = safeParse(url);
      if (!target) {
        event.preventDefault();
        return;
      }
      const allowedDev =
        DEV_RENDERER_ORIGIN.length > 0 && url.startsWith(DEV_RENDERER_ORIGIN);
      const allowedProd = target.protocol === "file:";
      if (!allowedDev && !allowedProd) {
        event.preventDefault();
        void openExternalIfAllowed(url);
      }
    });

    contents.on("will-attach-webview", (event) => {
      event.preventDefault();
    });

    contents.session.setPermissionRequestHandler(
      (_wc, _permission, callback) => {
        callback(false);
      },
    );
  });
}

export function applyCsp(): void {
  // 生产：file:// 严格 CSP；开发：允许 dev server origin + ws (HMR) + 'unsafe-eval'（vite/react devtools）
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    const dev = DEV_RENDERER_ORIGIN.length > 0;
    let wsOrigin = "";
    try {
      const u = new URL(DEV_RENDERER_ORIGIN);
      wsOrigin = `ws://${u.host} wss://${u.host}`;
    } catch {
      wsOrigin = "";
    }
    const csp = dev
      ? [
          `default-src 'self' ${DEV_RENDERER_ORIGIN}`,
          `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${DEV_RENDERER_ORIGIN}`,
          `style-src 'self' 'unsafe-inline' ${DEV_RENDERER_ORIGIN}`,
          `connect-src 'self' ${DEV_RENDERER_ORIGIN} ${wsOrigin}`,
          "img-src 'self' data: blob:",
          "font-src 'self' data:",
        ].join("; ")
      : [
          "default-src 'self'",
          "script-src 'self'",
          "style-src 'self' 'unsafe-inline'",
          "connect-src 'self'",
          "img-src 'self' data: blob:",
          "font-src 'self' data:",
        ].join("; ");
    cb({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [csp],
      },
    });
  });
}

export async function openExternalIfAllowed(url: string): Promise<void> {
  const parsed = safeParse(url);
  if (!parsed) return;
  if (!ALLOWED_EXTERNAL_PROTOCOLS.has(parsed.protocol)) {
    console.warn("[stela] blocked external url with disallowed protocol", url);
    return;
  }
  try {
    await shell.openExternal(url);
  } catch (err) {
    console.error("[stela] openExternal failed", url, err);
  }
}

function safeParse(u: string): URL | null {
  try {
    return new URL(u);
  } catch {
    return null;
  }
}
