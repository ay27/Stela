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
import { analysisCanvasFlowLayoutPatchSchema } from "./analysis-canvas";

const stringPath = z.string().min(1).max(8192);
const stringMin1 = z.string().min(1);
const agentHistorySegment = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

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
const aiContextWindowSchema = z.union([
  z.literal(64_000),
  z.literal(128_000),
  z.literal(200_000),
  z.literal(256_000),
  z.literal(1_000_000),
]);
const aiProviderProfileSchema = z
  .object({
    id: z.string().min(1).max(128),
    name: z.string().min(1).max(128),
    vendorId: z.string().min(1).max(128),
    model: z.string().min(1).max(256),
    baseUrl: z.string().max(2048),
    contextWindow: aiContextWindowSchema,
    hasApiKey: z.boolean(),
  })
  .strict();

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
      .object({
        onError: z.enum(["continue", "stop"]),
        maxRows: z.number().int().min(0).max(1_000_000),
      })
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
        activeProfileId: z.string().min(1).max(128),
        profiles: z.array(aiProviderProfileSchema).max(32),
        baseUrl: z.string().max(2048),
        model: z.string().max(256),
        hasApiKey: z.boolean(),
        contextWindow: aiContextWindowSchema,
        agentMaxIterations: z.number().int().min(1).max(10_000),
        agentWallClockMs: z.number().int().min(5_000).max(600_000),
        agentAllowMutations: z.boolean(),
        automaticSkillMaintenanceEnabled: z.boolean(),
        inlineCompletionEnabled: z.boolean(),
        completionProfileId: z.string().min(1).max(128).nullable(),
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
  [IPC.CANVAS_READ]: z.object({ path: stringPath }).strict(),
  [IPC.CANVAS_CREATE]: z.object({ directory: stringPath, title: z.string().trim().min(1).max(200) }).strict(),
  [IPC.CANVAS_REFRESH_SOURCE]: z.object({ path: stringPath, etag: z.string().regex(/^[a-f0-9]{64}$/), sourceId: agentHistorySegment }).strict(),
  [IPC.CANVAS_UPDATE_FLOW_LAYOUT]: z.object({ path: stringPath, etag: z.string().regex(/^[a-f0-9]{64}$/), cardId: agentHistorySegment, patch: analysisCanvasFlowLayoutPatchSchema }).strict(),

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

  [IPC.SQL_INDEX_QUERY]: z.object({
    filter: z.object({
      operations: z
        .array(z.enum(["select", "insert", "replace", "update", "delete", "upsert", "ddl", "other"]))
        .optional(),
      readTable: z.string().min(1).max(256).optional(),
      writeTable: z.string().min(1).max(256).optional(),
      writeColumn: z
        .object({ table: z.string().min(1).max(256), column: z.string().min(1).max(256) })
        .optional(),
      maxHits: z.number().int().min(1).max(2000).optional(),
    }),
  }),
  [IPC.SQL_INDEX_FACETS]: z.object({}).strict(),
  [IPC.SQL_INDEX_STATUS]: z.object({}).strict(),

  [IPC.PRIVACY_GET_STATUS]: z.object({}).strict(),

  [IPC.AI_GET_STATUS]: z.object({}).strict(),
  [IPC.AI_CONFIGURE]: z
    .object({
      settings: z
        .object({
          providerMode: z.enum(["disabled", "openai-compatible", "cloud"]).optional(),
          baseUrl: z.string().max(2048).optional(),
          model: z.string().max(256).optional(),
          contextWindow: aiContextWindowSchema.optional(),
          agentMaxIterations: z.number().int().min(1).max(10_000).optional(),
          agentWallClockMs: z.number().int().min(5_000).max(600_000).optional(),
          agentAllowMutations: z.boolean().optional(),
          automaticSkillMaintenanceEnabled: z.boolean().optional(),
          inlineCompletionEnabled: z.boolean().optional(),
          completionProfileId: z.string().min(1).max(128).nullable().optional(),
          activeProfileId: z.string().min(1).max(128).optional(),
          profiles: z.array(aiProviderProfileSchema).max(32).optional(),
        })
        .strict(),
      apiKey: z.string().max(8192).nullable().optional(),
      profileId: z.string().min(1).max(128).nullable().optional(),
    })
    .strict(),
  [IPC.AI_CLEAR_API_KEY]: z
    .object({
      profileId: z.string().min(1).max(128).nullable().optional(),
    })
    .strict(),
  [IPC.AI_PARSE_SQL_QUERY]: z
    .object({
      request: z
        .object({
          question: z.string().min(1).max(2_000),
          locale: z.enum(["zh", "en"]).optional(),
        })
        .strict(),
    })
    .strict(),
  [IPC.AI_INLINE_COMPLETION_START]: z
    .object({
      request: z
        .object({
          requestId: z.string().min(1).max(128),
          prefix: z.string().max(20_000),
          suffix: z.string().max(20_000),
          siblingSqls: z.array(z.string().max(8_000)).max(16),
          connectionName: z.string().min(1).max(256).nullable(),
          tableSchemas: z
            .array(
              z
                .object({
                  database: z.string().max(256).nullable().optional(),
                  table: z.string().max(256).nullable().optional(),
                  columns: z
                    .array(
                      z
                        .object({
                          name: z.string().max(256),
                          typeName: z.string().max(256),
                          comment: z.string().max(1_000).optional(),
                        })
                        .strict(),
                    )
                    .max(200)
                    .optional(),
                })
                .strict(),
            )
            .max(8)
            .optional(),
          heading: z.string().max(500).nullable().optional(),
          prose: z.string().max(2_000).nullable().optional(),
        })
        .strict(),
    })
    .strict(),
  [IPC.AI_INLINE_COMPLETION_CANCEL]: z
    .object({ requestId: z.string().min(1).max(128) })
    .strict(),
  [IPC.AI_METRICS_GET_DASHBOARD]: z
    .object({ range: z.enum(["7d", "30d", "90d"]) })
    .strict(),
  [IPC.AI_METRICS_LIST_RUNS]: z
    .object({
      filter: z.object({
        range: z.enum(["7d", "30d", "90d"]),
        surface: z.enum([
          "agent", "tool", "skill_maintenance", "ai_action", "sql_query_parse",
        ]).optional(),
        status: z.enum(["running", "completed", "error", "cancelled", "timeout", "dropped"]).optional(),
        cursor: z.string().max(256).regex(/^\d+:.+$/).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      }).strict(),
    })
    .strict(),
  [IPC.AI_METRICS_GET_TRACE]: z.object({ runId: z.string().min(1).max(256) }).strict(),
  [IPC.AI_METRICS_GET_SESSION_TRACE]: z
    .object({ sessionId: agentHistorySegment, deviceSlug: agentHistorySegment })
    .strict(),
  [IPC.AI_METRICS_CLEAR]: z.object({}).strict(),

  [IPC.AI_AGENT_RUN]: z
    .object({
      request: z
        .object({
          runId: stringMin1.max(128),
          sessionId: agentHistorySegment.optional(),
          entryPoint: z.enum([
            "chat",
            "runsql-fix",
            "runsql-rewrite",
            "runsql-ask",
            "schema-explain",
          ]).optional(),
          message: z.object({
            version: z.literal(1),
            segments: z.array(z.discriminatedUnion("kind", [
              z.object({ kind: z.literal("text"), text: z.string().max(20_000) }).strict(),
              z.object({ kind: z.literal("resource"), resourceId: z.string().min(1).max(128) }).strict(),
            ])).max(128),
            resources: z.array(z.discriminatedUnion("kind", [
              z.object({
                id: z.string().min(1).max(128),
                kind: z.literal("table"),
                label: z.string().min(1).max(256),
                table: z.string().min(1).max(512),
                connectionName: z.string().max(256).nullable().optional(),
              }).strict(),
              z.object({
                id: z.string().min(1).max(128),
                kind: z.enum(["note", "canvas"]),
                label: z.string().min(1).max(256),
                path: z.string().min(1).max(8192),
              }).strict(),
              z.object({
                id: z.string().min(1).max(128),
                kind: z.literal("selection"),
                label: z.string().min(1).max(256),
                text: z.string().min(1).max(30_000),
                sourcePath: z.string().max(8192).optional(),
                locator: z.object({
                  blockId: z.string().max(256).nullable().optional(),
                  blockIndex: z.number().int().min(0).optional(),
                  keyword: z.string().max(30_000).optional(),
                  nthInFile: z.number().int().min(0).optional(),
                  line: z.number().int().min(1).optional(),
                  column: z.number().int().min(1).optional(),
                }).strict().optional(),
              }).strict(),
              z.object({
                id: z.string().min(1).max(128),
                kind: z.literal("runsql"),
                label: z.string().min(1).max(256),
                sql: z.string().min(1).max(30_000),
                sourcePath: z.string().max(8192).optional(),
                locator: z.object({
                  blockId: z.string().max(256).nullable().optional(),
                  blockIndex: z.number().int().min(0).optional(),
                  keyword: z.string().max(30_000).optional(),
                  nthInFile: z.number().int().min(0).optional(),
                  line: z.number().int().min(1).optional(),
                  column: z.number().int().min(1).optional(),
                }).strict().optional(),
                rewriteTargetId: z.string().min(1).max(256).optional(),
              }).strict(),
            ])).max(32),
          }).strict().superRefine((message, context) => {
            const ids = new Set(message.resources.map((resource) => resource.id));
            if (ids.size !== message.resources.length) {
              context.addIssue({ code: z.ZodIssueCode.custom, message: "Agent resource ids must be unique." });
            }
            if (message.segments.some((segment) => segment.kind === "resource" && !ids.has(segment.resourceId))) {
              context.addIssue({ code: z.ZodIssueCode.custom, message: "Agent message references an unknown resource." });
            }
            const textLength = message.segments.reduce((length, segment) =>
              length + (segment.kind === "text" ? segment.text.length : 0), 0);
            if (textLength > 20_000) {
              context.addIssue({ code: z.ZodIssueCode.custom, message: "Agent message text is too long." });
            }
          }).optional(),
          prompt: z.string().min(1).max(20_000),
          workspaceContext: z.object({
            kind: z.enum(["note", "canvas"]),
            path: z.string().min(1).max(8192),
          }).strict().optional(),
          connectionName: z.string().max(256).nullable().optional(),
          mentionedTables: z.array(z.string().max(512)).max(8).optional(),
          referencedNotes: z.array(z.string().min(1).max(8192)).max(16).optional(),
          attachments: z
            .array(
              z.discriminatedUnion("kind", [
                z
                  .object({
                    kind: z.literal("selection"),
                    label: z.string().min(1).max(256),
                    text: z.string().min(1).max(30_000),
                    sourcePath: z.string().max(8192).optional(),
                  })
                  .strict(),
                z
                  .object({
                    kind: z.literal("runsql"),
                    label: z.string().min(1).max(256),
                    sql: z.string().min(1).max(30_000),
                    sourcePath: z.string().max(8192).optional(),
                    rewriteTargetId: z.string().min(1).max(256).optional(),
                    errorMessage: z.string().max(20_000).optional(),
                  })
                  .strict(),
              ]),
            )
            .max(12)
            .optional(),
          notePath: z.string().max(8192).nullable().optional(),
          canvasPath: z.string().max(8192).nullable().optional(),
          locale: z.enum(["zh", "en"]).optional(),
          profileId: z.string().min(1).max(128).nullable().optional(),
        })
        .strict(),
    })
    .strict(),
  [IPC.AI_AGENT_CANCEL]: z.object({ runId: stringMin1.max(128) }),
  [IPC.AI_AGENT_HISTORY_LIST]: z.object({}).strict(),
  [IPC.AI_AGENT_HISTORY_LOAD]: z
    .object({ sessionId: agentHistorySegment, deviceSlug: agentHistorySegment })
    .strict(),
  [IPC.AI_SKILLS_LIST]: z.object({}).strict(),
  [IPC.AI_SKILLS_REMOVE]: z
    .object({ relativePath: z.string().min(1).max(512) })
    .strict(),
  [IPC.AI_AGENT_RESPOND_PROPOSAL]: z.object({
    runId: stringMin1.max(128),
    callId: stringMin1.max(256),
    approve: z.boolean(),
    /** `question` kind 的自由文本答案；approve=false 时忽略。 */
    answer: z.string().max(4_000).optional(),
  }),
  [IPC.AI_PYTHON_RUNTIME_READ_INPUT]: z
    .object({
      jobId: z.string().uuid(),
      alias: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
      offset: z.number().int().nonnegative(),
      length: z.number().int().min(1).max(4 * 1024 * 1024),
    })
    .strict(),
  [IPC.AI_PYTHON_RUNTIME_RESPOND]: z
    .object({
      jobId: z.string().uuid(),
      result: z
        .object({
          ok: z.boolean(),
          stdout: z.string().max(64 * 1024),
          value: z.discriminatedUnion("kind", [
            z.object({ kind: z.literal("none") }).strict(),
            z.object({ kind: z.literal("scalar"), value: z.unknown() }).strict(),
            z
              .object({
                kind: z.literal("table"),
                columns: z.array(columnDefSchema).max(500),
                rows: z.array(z.array(z.unknown()).max(500)).max(200),
                rowCount: z.number().int().nonnegative(),
                truncated: z.boolean(),
              })
              .strict(),
          ]),
          elapsedMs: z.number().int().nonnegative(),
          error: z.string().max(16_000).optional(),
        })
        .strict(),
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
    push: z.boolean().optional(),
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

  [IPC.WINDOW_SYNC_TITLEBAR]: z.object({
    dark: z.boolean(),
    mode: themeModeSchema,
  }),

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
  [IPC.EXPORT_SAVE_FILE]: z
    .object({
      suggestedName: z.string().min(1).max(255),
      content: z.string(),
      title: z.string().min(1).max(256).optional(),
      filters: z
        .array(
          z.object({
            name: z.string().min(1).max(128),
            extensions: z.array(z.string().min(1).max(32)).min(1).max(16),
          }).strict(),
        )
        .min(1)
        .max(8),
    })
    .strict(),
  [IPC.EXPORT_REVEAL_SAVED_FILE]: z
    .object({ revealToken: z.string().uuid() })
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
