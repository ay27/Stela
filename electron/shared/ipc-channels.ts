/**
 * IPC channel 名常量集中定义。
 *
 * 设计原则：
 * - 一个业务能力一个 channel，不暴露通用的 invoke(channel, args)
 * - 命名 `domain:action`，方便日志聚合
 * - 仅用作类型/字符串常量，不携带任何运行时逻辑（main 与 renderer 都引用）
 *
 * 所有 channel 的 schema 见 ./ipc-schema.ts。
 */

export const IPC = {
  // Vault FS
  VAULT_LIST_DIR: "vault:list-dir",
  VAULT_READ_FILE: "vault:read-file",
  VAULT_READ_BINARY: "vault:read-binary",
  VAULT_WRITE_FILE: "vault:write-file",
  VAULT_PATH_EXISTS: "vault:path-exists",
  VAULT_CREATE_DIR: "vault:create-dir",
  VAULT_CREATE_FILE: "vault:create-file",
  VAULT_RENAME_PATH: "vault:rename-path",
  VAULT_DELETE_PATH: "vault:delete-path",
  VAULT_DB_SIZE: "vault:db-size",

  // Dialog
  DIALOG_PICK_VAULT: "dialog:pick-vault",
  DIALOG_PICK_DIRECTORY: "dialog:pick-directory",
  DIALOG_PICK_FILE: "dialog:pick-file",

  // Settings & connections store（vault 化重构后，main 端按 currentVault 路由）
  SETTINGS_LOAD: "settings:load",
  SETTINGS_PATCH: "settings:patch",
  CONNECTIONS_LOAD: "connections:load",
  CONNECTIONS_UPSERT: "connections:upsert",
  CONNECTIONS_REMOVE: "connections:remove",

  // User cache（跨 vault，机器级）：lastVault + recentVaults
  USER_CACHE_LOAD: "user-cache:load",
  USER_CACHE_PATCH: "user-cache:patch",

  // Vault context：renderer 切 vault 时调，触发 main 端 setCurrentVault
  VAULT_SET_CURRENT: "vault:set-current",
  VAULT_GET_CURRENT: "vault:get-current",

  // Storage (SQLite result store)
  STORAGE_OPEN: "storage:open",
  STORAGE_SAVE_RUN: "storage:save-run",
  STORAGE_SAVE_SCHEMA: "storage:save-schema",
  STORAGE_SAVE_ROWS: "storage:save-rows",
  STORAGE_QUERY_PAGE: "storage:query-page",
  STORAGE_GET_SCHEMA: "storage:get-schema",
  STORAGE_LIST_RUNS: "storage:list-runs",
  STORAGE_LIST_RUNS_BY_BLOCK: "storage:list-runs-by-block",
  STORAGE_CLEANUP: "storage:cleanup",

  // Connectors
  CONNECTOR_LIST_KINDS: "connector:list-kinds",
  CONNECTOR_TEST: "connector:test",
  CONNECTOR_EXECUTE: "connector:execute",
  CONNECTOR_LIST_DATABASES: "connector:list-databases",
  CONNECTOR_LIST_TABLES: "connector:list-tables",

  // Connector plugin management（subprocess + module 插件）
  CONNECTOR_LIST_PLUGINS: "connector:list-plugins",
  CONNECTOR_INSTALL_PLUGIN: "connector:install-plugin",
  CONNECTOR_UNINSTALL_PLUGIN: "connector:uninstall-plugin",
  CONNECTOR_GET_PLUGIN_LOGS: "connector:get-plugin-logs",
  CONNECTOR_START_PLUGIN: "connector:start-plugin",
  CONNECTOR_STOP_PLUGIN: "connector:stop-plugin",
  CONNECTOR_RESTART_PLUGIN: "connector:restart-plugin",
  // Module 插件（进程内 JS 模块）：从目录安装 / 自带 catalog / 一键安装
  CONNECTOR_INSTALL_MODULE_PLUGIN: "connector:install-module-plugin",
  CONNECTOR_LIST_BUNDLED_PLUGINS: "connector:list-bundled-plugins",
  CONNECTOR_INSTALL_BUNDLED_PLUGIN: "connector:install-bundled-plugin",

  // Search
  SEARCH_VAULT: "search:vault",
  SEARCH_LIST_FILES: "search:list-files",

  // Privacy / credential storage status
  PRIVACY_GET_STATUS: "privacy:get-status",

  // Search-first AI（provider secrets stay in main）
  AI_GET_STATUS: "ai:get-status",
  AI_CONFIGURE: "ai:configure",
  AI_CLEAR_API_KEY: "ai:clear-api-key",
  AI_COMPLETE: "ai:complete",
  AI_FIM_COMPLETE: "ai:fim-complete",

  // Git 版本控制（替代 COS 同步；笔记 + JSONL 历史走 git remote）
  GIT_IS_REPO: "git:is-repo",
  GIT_INIT_REPO: "git:init-repo",
  GIT_CLONE_REPO: "git:clone-repo",
  GIT_VAULT_STATUS: "git:vault-status",
  GIT_COMMIT: "git:commit",
  GIT_PUSH: "git:push",
  GIT_PULL: "git:pull",
  GIT_REMOTE_STATUS: "git:remote-status",
  GIT_ADD_REMOTE: "git:add-remote",
  GIT_MODIFIED_FILES: "git:modified-files",
  GIT_FILE_DIFF: "git:file-diff",
  GIT_FILE_DIFF_AT_COMMIT: "git:file-diff-at-commit",
  GIT_FILE_HISTORY: "git:file-history",
  GIT_VAULT_PULSE: "git:vault-pulse",
  GIT_LAST_COMMIT: "git:last-commit",
  GIT_CONFLICT_FILES: "git:conflict-files",
  GIT_CONFLICT_MODE: "git:conflict-mode",
  GIT_RESOLVE_CONFLICT: "git:resolve-conflict",
  GIT_COMMIT_CONFLICT_RESOLUTION: "git:commit-conflict-resolution",
  GIT_DISCARD_FILE: "git:discard-file",
  GIT_AUTHOR_IDENTITY: "git:author-identity",
  GIT_SET_AUTHOR_IDENTITY: "git:set-author-identity",
  // 统一同步编排：commit(+push) / pull(+journal import + refresh)
  GIT_SYNC_PUSH: "git:sync-push",
  GIT_SYNC_PULL: "git:sync-pull",

  // 执行历史 Journal（按设备分片 JSONL）
  JOURNAL_GET_DEVICE_PROFILE: "journal:get-device-profile",
  JOURNAL_SET_DEVICE_SLUG: "journal:set-device-slug",
  JOURNAL_APPEND_RUN: "journal:append-run",
  JOURNAL_IMPORT_INCREMENTAL: "journal:import-incremental",
  JOURNAL_IMPORT_RUN: "journal:import-run",
  JOURNAL_REBUILD_CACHE: "journal:rebuild-cache",
  JOURNAL_LIST_SOURCES: "journal:list-sources",
  JOURNAL_EXPORT_EXISTING: "journal:export-existing",
  JOURNAL_CLEANUP_OLDER_THAN: "journal:cleanup-older-than",

  // Shell
  SHELL_OPEN_EXTERNAL: "shell:open-external",
  SHELL_SHOW_ITEM_IN_FOLDER: "shell:show-item-in-folder",
  SHELL_OPEN_PATH: "shell:open-path",

  // Vault import：把外部文件复制进 vault（拖拽外部文件进文件树）
  VAULT_IMPORT_FILE: "vault:import-file",
  // 把剪贴板/拖拽里的二进制 blob 写到 note 旁边的 `<note-stem>.assets/` 目录
  VAULT_SAVE_ATTACHMENT: "vault:save-attachment",

  // App lifecycle (renderer 启动后回报，方便 main 决定窗口动作)
  APP_RENDERER_READY: "app:renderer-ready",

  // Auto update（第一版仅 macOS；manual check + explicit download/install）
  UPDATER_GET_STATUS: "updater:get-status",
  UPDATER_CHECK_FOR_UPDATES: "updater:check-for-updates",
  UPDATER_DOWNLOAD_UPDATE: "updater:download-update",
  UPDATER_QUIT_AND_INSTALL: "updater:quit-and-install",

  // Wiki / Vault index（v0.3 双链 M2/M3）
  INDEX_LIST_CANDIDATES: "index:list-candidates",
  INDEX_GET_BACKLINKS: "index:get-backlinks",
  INDEX_GET_ENTRY: "index:get-entry",

  // Export
  EXPORT_SAVE_MARKDOWN: "export:save-markdown",

} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
