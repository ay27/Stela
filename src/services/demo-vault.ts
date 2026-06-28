/**
 * Demo vault 引导。
 *
 * 用户从 Welcome 页点「试用 Demo Vault」时：
 *   1. 弹出目录选择，让用户选「父目录」
 *   2. 在该父目录下创建 `Stela Demo/`
 *   3. 写入一个简短的 welcome.md（含 markdown + runsql 示例 block）
 *   4. 由调用方触发 openVaultByPath 切换到这个新目录
 *
 * 设计选择：
 *   - 不直接读 sample.md，避免把仓库根的演示资源打进 renderer 包；demo 内容
 *     直接以常量内联，独立于打包结构。
 *   - 已存在 demo 目录 / welcome.md 时安静跳过创建（幂等），便于重复点击。
 */

import { createDir, createFile, pathExists } from "@/services/fs";

const DEMO_FOLDER_NAME = "Stela Demo";
const DEMO_NOTE_NAME = "welcome.md";

const DEMO_NOTE_CONTENT = `---
type: stela-data-note
created_at: "${new Date().toISOString()}"
---

# 欢迎使用 Stela

**Run SQL in Markdown. Track data in Stela.**

这是一个 demo vault。你可以在普通 markdown 之间穿插 RunSQL 代码块来执行查询，并把结果就近留在文档里。

## 你可以这样用

1. 在「连接管理」里配置一个 MySQL / HTTP 连接
2. 在文件 frontmatter 写入 \`connection_name: <你的连接名>\`
3. 像下面这样写一个 runsql 块，按 ⌘↵ 运行

\`\`\`runsql
SELECT 1 AS hello;
\`\`\`

执行结果会渲染为表格，并写入本地 SQLite（位于 vault 内的 \`.stela.sqlite\`）。
笔记本身只保留一个 detail 摘要，不会污染 markdown。

> 提示：⌘K 打开命令面板，⌘N 新建笔记，⌘B 折叠侧栏。
`;

/**
 * 在 `parentDir` 下 seed 一个 demo vault。
 *
 * @returns 新创建（或已存在）的 demo vault 绝对路径
 */
export async function seedDemoVault(parentDir: string): Promise<string> {
  const target = `${parentDir}/${DEMO_FOLDER_NAME}`;
  const dirExists = await pathExists(target).catch(() => false);
  if (!dirExists) {
    await createDir(parentDir, target);
  }
  const welcomePath = `${target}/${DEMO_NOTE_NAME}`;
  const noteExists = await pathExists(welcomePath).catch(() => false);
  if (!noteExists) {
    await createFile(target, welcomePath, DEMO_NOTE_CONTENT);
  }
  return target;
}
