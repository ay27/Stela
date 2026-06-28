/**
 * IPC payload 校验 schema。
 *
 * 约束：renderer 是不可信源，所有跨边界传入参数必须校验。
 * main IPC handler 在 invoke 入口处统一调用 `parseInput(channel, args)`。
 *
 * 校验失败抛 IpcValidationError，错误归一化后返回给 renderer。
 */

import { z } from "zod";

import { IPC, type IpcChannel } from "./ipc-channels";

const stringPath = z.string().min(1).max(8192);
const stringMin1 = z.string().min(1);

const fileNodeSchema = z.object({
  name: z.string(),
  path: z.string(),
  isDir: z.boolean(),
});

const columnDefSchema = z.object({
  name: z.string(),
  typeName: z.string(),
});

const runRecordSchema = z.object({
  runId: stringMin1,
  blockId: z.string(),
  sql: z.string(),
  status: z.enum(["ok", "err", "running"]),
  message: z.string().nullable(),
  startedAt: z.number().int().nonnegative(),
  elapsedMs: z.number().int().nonnegative(),
  rowCount: z.number().int().nonnegative(),
  connectionName: z.string(),
  notePath: z.string().nullable(),
});

const themeModeSchema = z.enum(["light", "dark", "system"]);
const editorWidthSchema = z.enum(["narrow", "wide"]);

const recentFileEntrySchema = z.object({
  path: stringMin1,
  openedAt: z.number().int().nonnegative(),
});

const partialSettingsSchema = z
  .object({
    vault: z
      .object({
        recentFiles: z.array(recentFileEntrySchema).max(128),
      })
      .partial()
      .optional(),
    appearance: z.object({ theme: themeModeSchema }).partial().optional(),
    execution: z
      .object({ onError: z.enum(["continue", "stop"]) })
      .partial()
      .optional(),
    persistence: z
      .object({ cleanupMonths: z.number().int().min(0) })
      .partial()
      .optional(),
    ui: z
      .object({
        defaultPageSize: z.number().int().min(1).max(2000),
        editorWidth: editorWidthSchema,
      })
      .partial()
      .optional(),
    git: z
      .object({
        enabled: z.boolean(),
        autoCommit: z.boolean(),
        autoPush: z.boolean(),
        autoPull: z.boolean(),
        autoPullIntervalMs: z.number().int().min(30_000).max(86_400_000),
      })
      .partial()
      .optional(),
    ai: z
      .object({
        providerMode: z.enum(["disabled", "openai-compatible", "cloud"]),
        baseUrl: z.string().max(2048),
        model: z.string().max(256),
        hasApiKey: z.boolean(),
        sendResultSamples: z.boolean(),
        maxSampleRows: z.number().int().min(0).max(100),
      })
      .partial()
      .optional(),
  })
  .strict();

const connectionEntrySchema = z.object({
  kind: stringMin1,
  config: z.unknown(),
  schemaDir: z.string().optional(),
});

/**
 * 把每个 channel 映射到对应的 zod schema。
 *
 * 设计：renderer 永远以 args[0] 传入对象（约定，preload 强制）。这样 zod
 * 直接校验单个对象，避免拆位置参数。
 */
export const IPC_SCHEMAS: Record<IpcChannel, z.ZodType<unknown>> = {
  [IPC.VAULT_LIST_DIR]: z.object({ path: stringPath }),
  [IPC.VAULT_READ_FILE]: z.object({ path: stringPath }),
  [IPC.VAULT_READ_BINARY]: z.object({ path: stringPath }),
  [IPC.VAULT_WRITE_FILE]: z.object({
    path: stringPath,
    contents: z.string(),
  }),
  [IPC.VAULT_PATH_EXISTS]: z.object({ path: stringPath }),
  [IPC.VAULT_CREATE_DIR]: z.object({
    vaultPath: stringPath,
    path: stringPath,
  }),
  [IPC.VAULT_CREATE_FILE]: z.object({
    vaultPath: stringPath,
    path: stringPath,
    contents: z.string(),
  }),
  [IPC.VAULT_RENAME_PATH]: z.object({
    vaultPath: stringPath,
    from: stringPath,
    to: stringPath,
  }),
  [IPC.VAULT_DELETE_PATH]: z.object({
    vaultPath: stringPath,
    path: stringPath,
  }),
  [IPC.VAULT_DB_SIZE]: z.object({ vaultPath: stringPath }),

  [IPC.DIALOG_PICK_VAULT]: z.object({}).strict(),
  [IPC.DIALOG_PICK_DIRECTORY]: z.object({
    title: z.string().max(256).optional(),
    defaultPath: z.string().max(8192).optional(),
  }),
  [IPC.DIALOG_PICK_FILE]: z.object({
    title: z.string().max(256).optional(),
    defaultPath: z.string().max(8192).optional(),
    /** 可选 file filter，[{ name, extensions[] }] */
    filters: z
      .array(
        z.object({
          name: z.string().min(1).max(128),
          extensions: z.array(z.string().min(1).max(32)).max(32),
        }),
      )
      .max(16)
      .optional(),
  }),

  [IPC.SETTINGS_LOAD]: z.object({}).strict(),
  [IPC.SETTINGS_PATCH]: z.object({ patch: partialSettingsSchema }),
  [IPC.CONNECTIONS_LOAD]: z.object({}).strict(),
  [IPC.CONNECTIONS_UPSERT]: z.object({
    name: stringMin1,
    entry: connectionEntrySchema,
  }),
  [IPC.CONNECTIONS_REMOVE]: z.object({ name: stringMin1 }),

  [IPC.USER_CACHE_LOAD]: z.object({}).strict(),
  [IPC.USER_CACHE_PATCH]: z.object({
    patch: z
      .object({
        recentVaults: z.array(stringMin1).max(64).optional(),
        lastVault: z.string().nullable().optional(),
        locale: z.enum(["system", "zh", "en"]).optional(),
        updateLastCheckedAt: z.number().int().nonnegative().nullable().optional(),
      })
      .strict(),
  }),

  [IPC.VAULT_SET_CURRENT]: z.object({
    vaultPath: z.string().nullable(),
  }),
  [IPC.VAULT_GET_CURRENT]: z.object({}).strict(),

  [IPC.STORAGE_OPEN]: z.object({ vaultPath: stringPath }),
  [IPC.STORAGE_SAVE_RUN]: z.object({ record: runRecordSchema }),
  [IPC.STORAGE_SAVE_SCHEMA]: z.object({
    runId: stringMin1,
    columns: z.array(columnDefSchema),
  }),
  [IPC.STORAGE_SAVE_ROWS]: z.object({
    runId: stringMin1,
    rows: z.array(z.array(z.unknown())),
    /**
     * 分块写入时该 batch 的起始行号（默认 0）。
     * Main 端用 `rowOffset + i` 作为 result_rows.row_index，多 batch 顺序调用
     * 即可拼成完整结果集，避免一次性传几万行触发结构化克隆 + GC 尖峰。
     */
    rowOffset: z.number().int().nonnegative().optional(),
  }),
  [IPC.STORAGE_QUERY_PAGE]: z.object({
    runId: stringMin1,
    offset: z.number().int().nonnegative(),
    limit: z.number().int().min(1).max(10_000),
  }),
  [IPC.STORAGE_GET_SCHEMA]: z.object({ runId: stringMin1 }),
  [IPC.STORAGE_LIST_RUNS]: z.object({}).strict(),
  [IPC.STORAGE_LIST_RUNS_BY_BLOCK]: z.object({
    blockId: stringMin1,
    limit: z.number().int().min(1).max(200).optional(),
    offset: z.number().int().nonnegative().optional(),
    status: z.enum(["ok", "err", "all"]).optional(),
  }),
  [IPC.STORAGE_CLEANUP]: z.object({
    keepDays: z.number().int().min(0),
  }),

  [IPC.CONNECTOR_LIST_KINDS]: z.object({}).strict(),
  [IPC.CONNECTOR_TEST]: z.object({
    kind: stringMin1,
    config: z.unknown(),
  }),
  [IPC.CONNECTOR_EXECUTE]: z.object({
    kind: stringMin1,
    config: z.unknown(),
    sql: z.string(),
  }),
  [IPC.CONNECTOR_LIST_DATABASES]: z.object({
    kind: stringMin1,
    config: z.unknown(),
  }),
  [IPC.CONNECTOR_LIST_TABLES]: z.object({
    kind: stringMin1,
    config: z.unknown(),
    db: z.string().nullable().optional(),
  }),

  [IPC.CONNECTOR_LIST_PLUGINS]: z.object({}).strict(),
  [IPC.CONNECTOR_INSTALL_PLUGIN]: z.object({
    input: z.object({
      exePath: stringPath,
      args: z.array(z.string().max(8192)).max(64).optional(),
      env: z.record(z.string().max(8192)).optional(),
    }),
  }),
  [IPC.CONNECTOR_UNINSTALL_PLUGIN]: z.object({ kind: stringMin1 }),
  [IPC.CONNECTOR_GET_PLUGIN_LOGS]: z.object({ kind: stringMin1 }),
  [IPC.CONNECTOR_START_PLUGIN]: z.object({ kind: stringMin1 }),
  [IPC.CONNECTOR_STOP_PLUGIN]: z.object({ kind: stringMin1 }),
  [IPC.CONNECTOR_RESTART_PLUGIN]: z.object({ kind: stringMin1 }),
  [IPC.CONNECTOR_INSTALL_MODULE_PLUGIN]: z.object({
    input: z.object({ srcDir: stringPath }),
  }),
  [IPC.CONNECTOR_LIST_BUNDLED_PLUGINS]: z.object({}).strict(),
  [IPC.CONNECTOR_INSTALL_BUNDLED_PLUGIN]: z.object({ id: stringMin1 }),

  [IPC.SEARCH_VAULT]: z.object({
    vaultPath: stringPath,
    keyword: z.string(),
    caseSensitive: z.boolean().optional(),
    maxHits: z.number().int().min(1).max(10_000).nullable().optional(),
  }),
  [IPC.SEARCH_LIST_FILES]: z.object({
    vaultPath: stringPath,
    extensions: z.array(z.string()),
  }),

  [IPC.PRIVACY_GET_STATUS]: z.object({}).strict(),

  [IPC.AI_GET_STATUS]: z.object({}).strict(),
  [IPC.AI_CONFIGURE]: z
    .object({
      settings: z
        .object({
          providerMode: z.enum(["disabled", "openai-compatible", "cloud"]).optional(),
          baseUrl: z.string().max(2048).optional(),
          model: z.string().max(256).optional(),
          sendResultSamples: z.boolean().optional(),
          maxSampleRows: z.number().int().min(0).max(100).optional(),
        })
        .strict(),
      apiKey: z.string().max(8192).nullable().optional(),
    })
    .strict(),
  [IPC.AI_CLEAR_API_KEY]: z.object({}).strict(),
  [IPC.AI_COMPLETE]: z
    .object({
      request: z.object({
        action: z.enum([
          "rewrite-sql",
          "ask-sql",
          "generate-sql",
          "explain-sql",
          "optimize-sql",
          "debug-query",
          "explain-result",
          "summarize-diff",
          "find-anomalies",
          "write-analysis",
          "rewrite-selection",
          "add-limitations",
          "explain-table",
          "suggest-joins",
          "generate-data-dictionary",
          "find-related-queries",
        ]),
        locale: z.enum(["zh", "en"]).optional(),
        context: z.object({
          source: z.enum(["runsql", "result", "editor", "schema"]),
          notePath: z.string().max(8192).nullable().optional(),
          noteTitle: z.string().max(512).nullable().optional(),
          noteMarkdown: z.string().max(80_000).nullable().optional(),
          headingPath: z.array(z.string().max(256)).max(16).optional(),
          connectionName: z.string().max(256).nullable().optional(),
          connector: z
            .object({
              kind: z.string().max(128),
              displayName: z.string().max(256),
              dialect: z.string().max(128),
            })
            .nullable()
            .optional(),
          sql: z.string().max(80_000).nullable().optional(),
          selectedText: z.string().max(80_000).nullable().optional(),
          errorMessage: z.string().max(20_000).nullable().optional(),
          result: z
            .object({
              runId: z.string().max(256).nullable().optional(),
              blockId: z.string().max(256).nullable().optional(),
              rowCount: z.number().int().nonnegative().nullable().optional(),
              columns: z.array(columnDefSchema).max(500).optional(),
              rows: z.array(z.array(z.unknown())).max(100).optional(),
              diffSummary: z
                .object({
                  addedRows: z.number().int().nonnegative(),
                  removedRows: z.number().int().nonnegative(),
                  changedRows: z.number().int().nonnegative(),
                  schemaChanged: z.boolean(),
                })
                .nullable()
                .optional(),
            })
            .nullable()
            .optional(),
          schema: z
            .object({
              connectionName: z.string().max(256).nullable().optional(),
              database: z.string().max(512).nullable().optional(),
              table: z.string().max(512).nullable().optional(),
              columns: z.array(columnDefSchema).max(500).optional(),
              ddlSnippet: z.string().max(20_000).nullable().optional(),
              source: z
                .enum(["explicit-sql", "schema-dir", "connector", "manual"])
                .optional(),
              matchReason: z.string().max(512).nullable().optional(),
              score: z.number().optional(),
            })
            .nullable()
            .optional(),
          schemas: z
            .array(
              z.object({
                connectionName: z.string().max(256).nullable().optional(),
                database: z.string().max(512).nullable().optional(),
                table: z.string().max(512).nullable().optional(),
                columns: z.array(columnDefSchema).max(500).optional(),
                ddlSnippet: z.string().max(20_000).nullable().optional(),
                source: z
                  .enum(["explicit-sql", "schema-dir", "connector", "manual"])
                  .optional(),
                matchReason: z.string().max(512).nullable().optional(),
                score: z.number().optional(),
              }),
            )
            .max(8)
            .optional(),
          userInstruction: z.string().max(20_000).nullable().optional(),
        }),
      }),
    })
    .strict(),

  // Git 版本控制
  [IPC.GIT_IS_REPO]: z.object({}).strict(),
  [IPC.GIT_INIT_REPO]: z.object({}).strict(),
  [IPC.GIT_CLONE_REPO]: z.object({
    remoteUrl: z.string().min(1).max(4096),
    localPath: stringPath,
  }),
  [IPC.GIT_VAULT_STATUS]: z.object({}).strict(),
  [IPC.GIT_COMMIT]: z.object({ message: z.string().min(1).max(4096) }),
  [IPC.GIT_PUSH]: z.object({}).strict(),
  [IPC.GIT_PULL]: z.object({}).strict(),
  [IPC.GIT_REMOTE_STATUS]: z.object({}).strict(),
  [IPC.GIT_ADD_REMOTE]: z.object({
    remoteUrl: z.string().min(1).max(4096),
  }),
  [IPC.GIT_MODIFIED_FILES]: z.object({
    includeStats: z.boolean().optional(),
  }),
  [IPC.GIT_FILE_DIFF]: z.object({ relPath: stringPath }),
  [IPC.GIT_FILE_DIFF_AT_COMMIT]: z.object({
    relPath: stringPath,
    commitHash: z.string().min(4).max(64),
  }),
  [IPC.GIT_FILE_HISTORY]: z.object({
    relPath: stringPath,
    limit: z.number().int().min(1).max(200).optional(),
  }),
  [IPC.GIT_VAULT_PULSE]: z.object({
    limit: z.number().int().min(1).max(200).optional(),
    skip: z.number().int().nonnegative().optional(),
  }),
  [IPC.GIT_LAST_COMMIT]: z.object({}).strict(),
  [IPC.GIT_CONFLICT_FILES]: z.object({}).strict(),
  [IPC.GIT_CONFLICT_MODE]: z.object({}).strict(),
  [IPC.GIT_RESOLVE_CONFLICT]: z.object({
    file: stringPath,
    strategy: z.enum(["ours", "theirs"]),
  }),
  [IPC.GIT_COMMIT_CONFLICT_RESOLUTION]: z.object({}).strict(),
  [IPC.GIT_DISCARD_FILE]: z.object({ relPath: stringPath }),
  [IPC.GIT_AUTHOR_IDENTITY]: z.object({}).strict(),
  [IPC.GIT_SET_AUTHOR_IDENTITY]: z.object({
    name: z.string().min(1).max(256),
    email: z.string().min(1).max(256),
  }),
  [IPC.GIT_SYNC_PUSH]: z.object({
    message: z.string().max(4096).optional(),
  }),
  [IPC.GIT_SYNC_PULL]: z.object({}).strict(),

  // 执行历史 Journal
  [IPC.JOURNAL_GET_DEVICE_PROFILE]: z.object({}).strict(),
  [IPC.JOURNAL_SET_DEVICE_SLUG]: z.object({
    slug: z.string().min(1).max(64),
  }),
  [IPC.JOURNAL_APPEND_RUN]: z.object({ runId: stringMin1 }),
  [IPC.JOURNAL_IMPORT_INCREMENTAL]: z.object({}).strict(),
  [IPC.JOURNAL_IMPORT_RUN]: z.object({ runId: stringMin1 }),
  [IPC.JOURNAL_REBUILD_CACHE]: z.object({}).strict(),
  [IPC.JOURNAL_LIST_SOURCES]: z.object({}).strict(),
  [IPC.JOURNAL_EXPORT_EXISTING]: z.object({}).strict(),
  [IPC.JOURNAL_CLEANUP_OLDER_THAN]: z.object({
    keepDays: z.number().int().min(0),
  }),

  [IPC.SHELL_OPEN_EXTERNAL]: z.object({ url: stringMin1 }),
  [IPC.SHELL_SHOW_ITEM_IN_FOLDER]: z.object({ path: stringPath }),
  [IPC.SHELL_OPEN_PATH]: z.object({ path: stringPath }),

  [IPC.VAULT_IMPORT_FILE]: z.object({
    vaultPath: stringPath,
    sourcePath: stringPath,
    destDir: stringPath,
  }),

  [IPC.VAULT_SAVE_ATTACHMENT]: z.object({
    vaultPath: stringPath,
    notePath: stringPath,
    /** 期望的文件名（含扩展名）；service 端再做一次 sanitize + 同名后缀 */
    fileName: z.string().min(1).max(255),
    /** base64 编码的二进制内容；上限 ~34MB（≈ 25MB 原始数据） */
    base64: z
      .string()
      .min(1)
      .max(34 * 1024 * 1024),
  }),

  [IPC.APP_RENDERER_READY]: z.object({}).strict(),

  [IPC.UPDATER_GET_STATUS]: z.object({}).strict(),
  [IPC.UPDATER_CHECK_FOR_UPDATES]: z.object({}).strict(),
  [IPC.UPDATER_DOWNLOAD_UPDATE]: z.object({}).strict(),
  [IPC.UPDATER_QUIT_AND_INSTALL]: z.object({}).strict(),

  [IPC.INDEX_LIST_CANDIDATES]: z.object({
    query: z.string().max(512),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  [IPC.INDEX_GET_BACKLINKS]: z.object({
    target: z.string().min(1).max(2048),
  }),
  [IPC.INDEX_GET_ENTRY]: z.object({
    path: stringPath,
  }),

  [IPC.EXPORT_SAVE_MARKDOWN]: z
    .object({
      suggestedName: z.string().min(1).max(255),
      content: z.string(),
      title: z.string().min(1).max(256).optional(),
    })
    .strict(),

};

export class IpcValidationError extends Error {
  readonly code = "ipc_invalid_input";
  constructor(
    public channel: string,
    public issues: z.ZodIssue[],
  ) {
    super(`invalid input on ${channel}: ${JSON.stringify(issues)}`);
  }
}

export function parseInput<T>(channel: IpcChannel, raw: unknown): T {
  const schema = IPC_SCHEMAS[channel];
  if (!schema) {
    throw new IpcValidationError(channel, [
      {
        code: "custom",
        path: [],
        message: `no schema for ${channel}`,
      } as z.ZodIssue,
    ]);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new IpcValidationError(channel, parsed.error.issues);
  }
  return parsed.data as T;
}

// 未使用导入消除（fileNodeSchema 仅作类型参考，导出给可能的扩展用）
export { fileNodeSchema };
