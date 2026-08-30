# Stela v0.14.0

Compared with v0.13.0, this release makes Vault Git synchronization more responsive and predictable, gives the Agent a safer path for full-result Python analysis, improves SQL inline completion, and refines Markdown table editing.

## English

### Highlights

- **Event-driven Git synchronization:** Git-enabled Vaults now coalesce local changes into one serialized synchronization transaction, react after a short quiet period and on focus or connectivity changes, and keep a periodic fallback scan. Incoming updates refresh affected settings, connections, execution history, Skills, templates, and Vault files without allowing overlapping sync jobs to race.
- **Full-result Python analysis without filling model context:** Agent Python can fetch complete read-only query results directly into the sandbox as DuckDB relations with `await query(connection, request)`. Queries are authorized and journaled in the main process, while the model sees only bounded previews instead of transporting large result sets through chat.
- **Guarded SQL fill-in-the-middle completion:** Official DeepSeek V4 Flash profiles use native prefix/suffix completion, while other profiles retain the bounded chat transport. Suggestions can appear at any edited SQL cursor position and are filtered for syntax regressions, schema conflicts, repetition, suffix overlap, and low-confidence output.
- **Cleaner Markdown table editing:** The editor now uses a clearly visible caret throughout Markdown and inside table headers and cells, stronger row and column controls, a single consistent table boundary, and cell-aware selection instead of accidental browser text selection.

### Improvements

- **More reliable Agent tool use:** Deterministic failures now return clearer field-level diagnostics and repeated failures trip a per-run circuit breaker. Note rewrite matching tolerates CRLF and trailing-whitespace differences, and stale Skills fail fast while maintenance proceeds separately.
- **Complete bounded schema results:** Wide-table schema responses preserve column coverage across every requested table before shedding optional detail. Approval previews focus on the changed region, and RunSQL rewrite targets are resolved from the current message resources.
- **Smaller Agent core with sourced system guidance:** The core prompt and tool descriptions are more compact. Optional system playbooks load as read-only sourced Skills, and plan operations use one action-oriented tool while plans remain progress bookkeeping rather than an answer gate.
- **Cross-platform Git reliability:** Git subprocess environment handling now preserves the Windows `Path` value correctly, and repository-owned pre-commit checks run tests, the public-release gate, and the production build before a commit is accepted.

### Upgrade Notes

- No manual data migration is required when upgrading from v0.13.0. Existing notes, Canvas files, SQL templates, connections, execution history, Agent history, and Vault Skills remain readable.
- Existing Git settings continue to control whether synchronization and automatic checkpoints are enabled. Dirty editor tabs still protect unsaved work, and real merge or rebase conflicts remain in the existing manual conflict-resolution flow; Stela does not silently stash changes or choose a side.
- Python `query()` calls are always enforced as read-only in the main process and create audited execution-history entries. Connection credentials never enter the Python worker.
- Native FIM is enabled only for the supported official DeepSeek V4 Flash profile. Other models continue to use the existing bounded chat completion path, and a failed native FIM request does not trigger an automatic paid fallback call.

## 中文

### 重点更新

- **事件驱动的 Git 同步：** 启用 Git 的 Vault 会把本地变化合并到一个串行同步事务中，在短暂静默后以及窗口重新聚焦、网络恢复时触发，同时保留周期性兜底检查。拉取到的变化会按影响范围刷新设置、连接、执行历史、Skills、模板和 Vault 文件，避免多个同步任务并发竞争。
- **无需占满模型上下文的全量 Python 分析：** Agent Python 可以通过 `await query(connection, request)` 将完整的只读查询结果直接载入沙箱中的 DuckDB relation。查询由 Main Process 授权并写入执行日志，模型侧只接收有边界的预览，不再通过对话搬运大结果集。
- **带防护的 SQL Fill-in-the-Middle 补全：** 官方 DeepSeek V4 Flash Profile 使用原生 Prefix/Suffix 补全，其他 Profile 继续使用有边界的 Chat Transport。编辑 SQL 后，任意光标位置都可以出现建议，并会过滤语法退化、Schema 冲突、重复内容、Suffix 重叠和低置信度输出。
- **更清晰的 Markdown 表格编辑：** Markdown 全文以及表头、Cell 内的光标现在都更清晰；行列操作控件更醒目，表格外框统一为单层边界，选区按 Cell 语义工作，不再意外退化成浏览器文本选择。

### 改进

- **更可靠的 Agent 工具调用：** 确定性失败会返回更清晰的字段级诊断，连续重复失败会触发本轮 Circuit Breaker。笔记改写匹配可以容忍 CRLF 和行尾空白差异，Stale Skill 会快速失败，维护任务则独立执行。
- **完整且有边界的 Schema 结果：** 宽表 Schema 会优先保留每张目标表的完整列覆盖，再缩减可选细节。修改确认预览会聚焦真实变更区域，RunSQL 改写目标也会从当前消息资源中正确解析。
- **更精简的 Agent Core 与有来源的系统指导：** 核心 Prompt 和 Tool Description 更短；可选系统 Playbook 以只读、带来源的 Skill 按需加载。计划操作合并为一个面向动作的工具，Plan 只负责进度记录，不再成为回答门槛。
- **跨平台 Git 可靠性：** Git 子进程现在会正确保留 Windows 的 `Path` 环境变量；仓库自带的 Pre-commit 检查会在允许提交前运行测试、公开发布检查和生产构建。

### 升级说明

- 从 v0.13.0 升级无需手动迁移数据。现有笔记、Canvas、SQL 模板、数据库连接、执行历史、Agent 历史和 Vault Skill 均可继续读取。
- 是否启用同步与自动 Checkpoint 仍由现有 Git 设置控制。未保存的编辑器 Tab 仍会保护本地工作，真实的 Merge 或 Rebase 冲突仍进入现有手动解决流程；Stela 不会静默 Stash，也不会自动选择任一方。
- Python `query()` 始终由 Main Process 强制执行只读限制，并生成可审计的执行历史记录；连接凭据不会进入 Python Worker。
- 原生 FIM 只对受支持的官方 DeepSeek V4 Flash Profile 启用。其他模型继续使用原有的有边界 Chat Completion；原生 FIM 请求失败时，不会自动发起额外的付费回退调用。
