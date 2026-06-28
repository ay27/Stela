/**
 * 当前文件查找（Cmd+F / Cmd+Alt+F）模块 barrel。
 */

export {
  clearActiveReveal,
  revealRange,
  setActiveReveal,
  type RevealHandle,
  type RevealOptions,
} from "./reveal";
export {
  useFindState,
  type FindMode,
  type FindState,
} from "./use-find-state";
export {
  close,
  next,
  prev,
  refresh,
  rescan,
  replace,
  replaceAll,
  teardown,
  type FindControllerOpts,
} from "./find-controller";
export { FindBar } from "./find-bar";
