import { scheduleAutoGit } from "@/services/auto-git";
import { setKnownDiskContent } from "@/services/note-save-tracker";

/**
 * 写入 vault 内文件。
 *
 * 副作用：成功后调一次 [`scheduleAutoGit`](./auto-git.ts) —— 编辑器自动保存
 * 与 RunSQL 写回 detail 都走这里，是 AutoGit 自动提交的主要触发入口。失败不会
 * schedule（上层抛错对应 UI 自然提示），避免错误状态下还把脏 buffer 提交上去。
 */
export async function writeFile(path: string, contents: string): Promise<void> {
  await window.stela.vault.writeFile(path, contents);
  setKnownDiskContent(path, contents);
  scheduleAutoGit("editor-save");
}
