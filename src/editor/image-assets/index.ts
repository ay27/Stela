/**
 * 图片附件子系统。Crepe 默认带 `@milkdown/plugin-upload`，会拦截 paste/drop
 * 调 `imageBlockConfig.onUpload` 拿 src。我们的策略是不再注册自己的 paste
 * plugin，而是接管 `onUpload`：写到 vault 的 `<note-stem>.assets/`，返回相对
 * POSIX 路径。markdown 由此保持干净的 `![](report.assets/foo.png)`。
 *
 * 模块组成：
 *   - file-name.ts：附件文件名生成（纯函数，单测覆盖）
 *   - path-resolver.ts：相对 src → 绝对路径解析（纯函数，单测覆盖）
 *   - image-cache.ts：abs path → blob URL 的 LRU 缓存
 *   - preview-overlay.tsx：双击图片放大查看
 *
 * MilkdownEditor.tsx 的 Crepe featureConfigs 里直接用这里的 helper：
 *   - onUpload     ← cacheBlob + window.stela.vault.saveAttachment
 *   - proxyDomURL  ← resolveImageSrc + getImageObjectURL
 */

export {
  cacheBlob,
  clearAll as clearImageCache,
  getImageObjectURL,
  invalidate as invalidateImageCache,
} from "./image-cache";
export { resolveImageSrc } from "./path-resolver";
export { buildAttachmentFileName } from "./file-name";
