/**
 * Stela Connector Plugin SDK（进程内 module 插件契约）。
 *
 * 这是一个**可独立发布**的零依赖包：第三方写自己的 connector 插件时只依赖本包的
 * 类型与 `defineConnectorPlugin` / `PluginError`，不需要引用 Stela 主程序源码。
 *
 * 插件最终被打包成单文件 CJS（见各 sample 的 build.mjs），由 Stela 主进程在
 * 打开 vault 时通过 `createRequire` 动态加载，并以**完整 Node/Electron 权限**运行。
 * 因此「安装一个 module 插件 = 完全信任它」，与 VSCode 扩展同级别。不信任来源的
 * connector 请改用 stdio 子进程协议（见 docs/connector-plugin-protocol.md）。
 *
 * 与主程序的运行时契约靠**结构（鸭子类型）**对齐，不依赖类实例 identity，所以
 * 本包刻意把所有 DTO 都重新声明一遍，保持自包含。
 */

/** 当前 module 插件协议版本。host 加载时校验 `apiVersion <=` 它支持的版本。 */
export const CONNECTOR_PLUGIN_API_VERSION = 2;

/** 结果集列定义。 */
export interface ColumnDef {
  name: string;
  /** 原始数据库列类型字符串（VARCHAR / DATETIME / BLOB 等），仅作前端表头展示。 */
  typeName: string;
}

/** execute 的返回：查询型（带行列）或变更型（带 affectedRows）。 */
export type QueryResult =
  | {
      kind: "query";
      columns: ColumnDef[];
      rows: unknown[][];
      elapsedMs: number;
    }
  | {
      kind: "mutation";
      affectedRows: number;
      elapsedMs: number;
    };

/** test 探活返回。 */
export interface TestResult {
  ok: boolean;
  message?: string;
  latencyMs?: number;
}

/**
 * Connector 直出的表结构。`describeTables` 是 schema 工具的专用 API：
 * 一次返回带 COMMENT 的列，避免 `SHOW CREATE` / `DESCRIBE` / `LIMIT 0`
 * 这种拼凑的探测链。`comment` 可选，老插件不实现时为 undefined。
 */
export interface TableDescriptor {
  database: string | null;
  table: string;
  columns: (ColumnDef & { comment?: string | null })[];
  ddlSnippet: string | null;
}

/**
 * connector kind 的元信息。`configSchema` 是 JSON Schema 风格对象，Stela 前端
 * 据此渲染连接配置表单；想做「专有 / 零配置」插件，只暴露需要用户填的字段即可
 * （把固定值硬编码在插件内部，不写进 schema）。
 */
export interface ConnectorKindMeta {
  /** 全局唯一的 connector 类型 id（例 mysql / http / my_gateway）。 */
  kind: string;
  displayName: string;
  /** JSON Schema 风格描述；前端按字段渲染表单。无可调字段可传 `{ type: "object", properties: {} }`。 */
  configSchema: unknown;
  /** 新建连接时的默认配置。 */
  defaultConfig: unknown;
  /** 是否子进程实现。module 插件一律 false。 */
  subprocess: boolean;
  /**
   * SQL 方言名（例 "MySQL" / "PostgreSQL" / "StarRocks"）。用于 AI prompt 提示、
   * 编辑器语法高亮/补全的 lezer dialect 选择、以及 SQL 事实索引的方言相关解析。
   * 不填时 host 端按 `kind`/`displayName` 做启发式回退（见 `resolveDialect`）。
   */
  dialect?: string;
  /** API v2: formats accepted by materializeQuery. */
  queryArtifactFormats?: QueryArtifactFormat[];
}

export type QueryArtifactFormat = "parquet" | "jsonl";

export interface QueryArtifactRequest {
  format: QueryArtifactFormat;
  /** Host-created temporary path. Write only this exact file. */
  outputPath: string;
  previewRows: number;
  maxBytes: number;
}

export interface MaterializedQueryResult {
  kind: "query";
  columns: ColumnDef[];
  previewRows: unknown[][];
  rowCount: number;
  elapsedMs: number;
}

/**
 * connector 运行时接口。插件 `create()` 必须返回实现本接口的对象。
 * 五个核心方法 + 可选 `dispose()`（vault 切换 / 卸载时由 host 调用，用于关连接池等）。
 */
export interface Connector {
  meta(): ConnectorKindMeta;
  test(config: unknown): Promise<TestResult>;
  execute(config: unknown, sql: string): Promise<QueryResult>;
  /**
   * API v2 optional capability. Stream a read-only query to the host-selected
   * artifact file instead of materializing the whole result in process memory.
   */
  materializeQuery?(
    config: unknown,
    sql: string,
    request: QueryArtifactRequest,
  ): Promise<MaterializedQueryResult>;
  listDatabases(config: unknown): Promise<string[]>;
  listTables(config: unknown, db?: string | null): Promise<string[]>;
  /**
   * 可选：批量拿表结构（含 COMMENT）。host 端默认回退到 listTables + DESCRIBE
   * 拼装。实现后能保留原生 COMMENT，是 AI 列注释打分的干净路径。
   */
  describeTables?(
    config: unknown,
    tables: Array<{ database: string | null; table: string }>,
  ): Promise<TableDescriptor[]>;
  /** 可选：释放底层资源（连接池 / socket）。host 在卸载或切 vault 时调用。 */
  dispose?(): void | Promise<void>;
}

/** host 注入给插件的轻量日志器。最终写进主进程日志（scope = 插件 id）。 */
export interface PluginLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** `create()` 拿到的上下文。 */
export interface PluginContext {
  /** 插件安装目录绝对路径（`{vault}/.stela/plugins/<id>/`）；可用于读取随包资源。 */
  pluginDir: string;
  log: PluginLogger;
}

/** 插件 entry 的默认导出形态。 */
export interface StelaConnectorPluginModule {
  /** 必须等于 {@link CONNECTOR_PLUGIN_API_VERSION}（或更低、被 host 兼容的版本）。 */
  apiVersion: number;
  /** 工厂：返回一个 {@link Connector} 实例。可在此读 ctx.pluginDir / 初始化资源。 */
  create(ctx: PluginContext): Connector;
}

/**
 * 插件抛错请用本类（而非裸 Error）。`code` 会原样透传到前端做错误分类，
 * `retryable` 提示 Stela 是否可自动重试。host 通过鸭子类型识别（读 `.code`），
 * 不依赖类 identity，跨打包边界也能正确归一化。
 */
export class PluginError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = "PluginError";
    this.code = code;
    this.retryable = retryable;
  }
}

/**
 * 定义插件的辅助函数：仅做类型收窄，运行时原样返回。
 * 推荐 `export default defineConnectorPlugin({ apiVersion: CONNECTOR_PLUGIN_API_VERSION, create() {...} })`。
 */
export function defineConnectorPlugin(
  mod: StelaConnectorPluginModule,
): StelaConnectorPluginModule {
  return mod;
}
