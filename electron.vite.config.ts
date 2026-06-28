import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

/**
 * electron-vite v5 配置。
 *
 * 项目结构（非默认）：
 *   - renderer 仍在 src/（保留现有 React 代码），入口 index.html 在根
 *   - main 进程在 electron/main/index.ts
 *   - preload 脚本在 electron/preload/index.ts
 *
 * v5 默认 build.outDir 为 out/main / out/preload / out/renderer，与我们预期一致，
 * 不显式设置（v5 类型层面拒绝在嵌套 build 块里多写 outDir）。
 *
 * 使用 rollupOptions.input 指向自定义入口路径。
 */
export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          index: path.resolve(__dirname, "electron/main/index.ts"),
        },
        external: [
          // native 模块：electron-vite 默认会 detect，这里显式列出避免被打包
          "better-sqlite3",
          "sqlite-vec",
          "sqlite-vec-darwin-arm64",
          "sqlite-vec-darwin-x64",
          "sqlite-vec-linux-x64",
          "sqlite-vec-linux-arm64",
          "sqlite-vec-windows-x64",
          "@xenova/transformers",
          "onnxruntime-node",
          "@modelcontextprotocol/sdk",
        ],
      },
    },
    resolve: {
      alias: {
        "@shared": path.resolve(__dirname, "electron/shared"),
        "@services": path.resolve(__dirname, "electron/services"),
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: {
          index: path.resolve(__dirname, "electron/preload/index.ts"),
        },
      },
    },
    resolve: {
      alias: {
        "@shared": path.resolve(__dirname, "electron/shared"),
      },
    },
  },
  renderer: {
    root: ".",
    build: {
      rollupOptions: {
        input: {
          index: path.resolve(__dirname, "index.html"),
        },
      },
    },
    plugins: [react()],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "src"),
        "@shared": path.resolve(__dirname, "electron/shared"),
      },
    },
    server: {
      port: 1420,
      strictPort: true,
    },
  },
});
