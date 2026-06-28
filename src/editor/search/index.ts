/**
 * 搜索高亮模块 barrel。统一对外导出本目录下的所有公开 API，避免上游 import 路径散乱。
 *
 * 模块边界：
 *   - source-map：源码行号 ↔ PM pos 静态映射（mount 时构建一次，编辑后过期）
 *   - locator：把 RevealLoc（keyword/slug/line）解为 PM range
 *   - search-highlight-plugin：PM Decoration 装饰命中关键字，跟随 doc 自动重定位
 */

export {
  buildLineMap,
  type LineMap,
  type LineMapEntry,
} from "./source-map";

export {
  findKeywordMatches,
  resolveReveal,
  type RevealLoc,
  type RevealRange,
} from "./locator";

export {
  clearSearch,
  searchHighlightPlugin,
  searchHighlightPluginKey,
  setSearch,
  type SearchHighlightMeta,
  type SearchHighlightState,
} from "./search-highlight-plugin";
