# Stela v0.11.0

Compared with v0.10.3, this release adds a full path from audited SQL results to visual analysis. You can keep the decision in Canvas, inspect how the Agent reached it, and reuse the SQL through templates.

## English

### Highlights

- **Analysis Canvas:** Turn audited query results into a Git-trackable `*.stela.canvas` with KPI, chart, table, narrative, and flow cards. Canvas sources keep their SQL and latest successful run reference without copying result rows into the artifact. Refresh one source or the whole Canvas explicitly; a failed refresh keeps the last successful snapshot.
- **Charts tied to query results:** The Agent can visualize an exact RunSQL result in the conversation or use it in a durable Canvas. Stela's controlled chart grammar covers trends, rankings, composition, distributions, correlations, funnels, retention, comparisons, and bounded layered views, with consistent number, percent, currency, date, and duration formatting.
- **Offline Canvas export:** Export a Canvas as one standalone HTML file. ECharts views retain tooltips, hover emphasis, legend interaction, and responsive resizing without a network connection. Tables and flow diagrams are stable snapshots, and the supporting SQL remains inspectable.
- **Agent Dashboard:** Review 7-, 30-, or 90-day activity, completion rate, latency, token usage, tool reliability, Skill selection and usage, knowledge-maintenance outcomes, and paginated redacted traces. The dashboard is Vault-local, Git-ignored, clearable, and never sends telemetry to Stela.
- **SQL template editing:** Create a template directly from the library and edit its name, description, connection, and RunSQL content in the normal editor. Insert it with `Mod+Alt+T`; repeated `{{variables}}` stay linked while editing, and `Tab` / `Shift+Tab` moves between variable groups.
- **Bilingual Demo Vault:** **Try Demo Vault** now creates one English-and-Chinese Northstar Outfitters commerce review instead of a single welcome note. It includes business context, audited SQL evidence, saved results, Canvas, Agent history, Skills, SQL templates, and an optional Docker-based MySQL fixture for rerunning the analysis.

### Improvements

- **Agent knowledge maintenance:** The main answer now finishes and unlocks before background Skill maintenance begins. Maintenance is Vault-scoped and bounded to 60 seconds and five model turns, while source hashes and retrieval anchors allow stale knowledge to be refreshed when supporting notes change.
- **Canvas flow diagrams:** Flow cards use a readable natural-size, scrollable preview instead of shrinking the whole diagram. Expand a flow for zooming and panning, then opt into layout adjustment for node dragging, TB/LR direction, and deterministic auto-layout. Open Canvas tabs also refresh when the Agent updates them.
- **Export path feedback:** Canvas HTML export now reports the saved local path, matching the existing Markdown export experience.
- **SQL template drafts:** The template library no longer keeps name and description fields in a separate creation form. New drafts open in the editor, use sortable timestamp-based filenames, and recover with a stable fallback name if closed before naming.
- **Shortcut documentation:** Settings and `docs/keybindings.md` now cover the product-defined workspace, editor, search, RunSQL, template-variable, and image-preview shortcuts.
- **macOS and Windows fixes:** macOS now waits for the native Vault watcher to unsubscribe before process teardown, preventing the FSEvents crash seen on quit. Demo validation also handles Windows CRLF checkouts.

### Upgrade Notes

- No manual migration is required when upgrading from v0.10.3. Existing Markdown notes, connections, execution history, Git settings, and SQL templates remain compatible.
- Agent Dashboard data starts accumulating after the upgrade; previous Agent history is not backfilled. Metrics and redacted traces live in `.stela/agent-metrics.local.sqlite`, are ignored by Git, expire after 90 days, and can be cleared from the dashboard.
- Canvas files (`*.stela.canvas`) and SQL template Markdown files under `.stela/sql-templates/` are normal Vault artifacts and may be committed to Git. Query result rows continue to live in Stela's existing JSONL history and local SQLite cache rather than inside Canvas files.
- A Canvas HTML export containing charts embeds the pinned ECharts runtime and is therefore roughly 1.1 MB larger. It runs embedded JavaScript for chart interaction, but makes no network requests and has no access to Stela IPC, database connectors, or the source Vault.
- The prepared Demo Vault can be browsed immediately from its saved results. Docker is required only to rerun the bundled MySQL queries, and an AI provider is required only for the live Agent and new Dashboard activity steps. Recreating the Demo in the same destination adds missing files but does not overwrite files you have edited.

## 中文

### 重点更新

- **分析画布：** 将经过审计的查询结果组织成可由 Git 跟踪的 `*.stela.canvas`，在同一画布中展示 KPI、图表、表格、分析文字和流程图。Canvas 数据源保存 SQL 与最近一次成功执行的引用，不把结果行复制进画布文件；你可以显式刷新单个或全部数据源，刷新失败时仍保留上一次成功快照。
- **与查询结果绑定的图表：** Agent 可以直接把某次 RunSQL 的准确结果可视化在对话中，也可以将其用于持久化 Canvas。Stela 的受控图表语法支持趋势、排名、构成、分布、相关性、漏斗、留存、对比和有限的分层图表，并统一处理数字、百分比、货币、日期和时长格式。
- **离线 Canvas 导出：** Canvas 可以导出为单个独立 HTML 文件。ECharts 图表在无网络环境下仍保留 Tooltip、Hover 高亮、图例交互和响应式缩放。表格与流程图导出为稳定快照，支撑分析的 SQL 也可以展开查看。
- **Agent Dashboard：** 查看最近 7、30 或 90 天的 Agent 活跃情况、完成率、耗时、Token 用量、工具可靠性、Skill 匹配与使用、知识维护结果，以及可分页查看的脱敏 Trace。Dashboard 数据仅保存在当前 Vault 的本机 Git 忽略文件中，可以随时清空，不会向 Stela 发送遥测数据。
- **SQL 模板编辑：** 从模板库创建模板后，直接在普通编辑器里修改名称、描述、连接和 RunSQL 内容。按 `Mod+Alt+T` 插入模板；重复的 `{{变量}}` 会保持联动编辑，并可用 `Tab` / `Shift+Tab` 在变量组之间跳转。
- **双语 Demo Vault：** **Try Demo Vault** 不再只创建一篇欢迎笔记，而是在同一个 Vault 中提供 Northstar Outfitters 电商经营复盘的中英文完整流程，包括业务背景、可审计 SQL 证据、已保存结果、Canvas、Agent 历史、Skills、SQL 模板，以及用于重新执行分析的可选 Docker MySQL 数据集。

### 改进

- **Agent 知识维护：** Agent 主回答完成后会立即解除会话占用，再独立执行后台 Skill 维护。维护任务按 Vault 隔离，最多运行 60 秒和 5 个模型轮次；通过来源哈希与检索锚点，支撑笔记发生变化时可以识别并刷新过期知识。
- **Canvas 流程图：** 流程图卡片改为自然尺寸、可滚动的清晰预览，不再为了显示完整流程而整体缩小。展开后可以缩放和平移，并按需进入布局调整模式，拖动节点、切换 TB/LR 方向或执行确定性的自动布局。Agent 更新画布时，已经打开的 Canvas 标签页也会同步刷新。
- **导出路径提示：** Canvas HTML 导出成功后会显示本地保存路径，与现有 Markdown 导出的体验保持一致。
- **SQL 模板草稿：** 模板库不再用单独的创建表单重复填写名称和描述。新草稿会直接进入编辑器，使用可排序的时间戳文件名；如果尚未命名就关闭，也会生成稳定的兜底名称，避免丢失草稿。
- **快捷键说明：** Settings 与 `docs/keybindings.md` 现在完整列出工作区、编辑器、搜索、RunSQL、模板变量和图片预览相关的产品快捷键。
- **macOS 与 Windows 修复：** macOS 退出时会等待原生 Vault watcher 完成退订，避免进程析构阶段发生 FSEvents 崩溃；Demo 校验也已兼容 Windows 的 CRLF checkout。

### 升级说明

- 从 v0.10.3 升级无需手动迁移。已有 Markdown 笔记、数据库连接、执行历史、Git 设置和 SQL 模板保持兼容。
- Agent Dashboard 从升级后开始积累数据，不会回填旧的 Agent 历史。指标与脱敏 Trace 保存在 `.stela/agent-metrics.local.sqlite`，默认不进入 Git，保留 90 天，并可在 Dashboard 中清空。
- Canvas 文件（`*.stela.canvas`）以及 `.stela/sql-templates/` 下的 SQL 模板 Markdown 都是普通 Vault 文件，可以提交到 Git。查询结果行仍保存在现有 JSONL 历史与本地 SQLite 缓存中，不会写入 Canvas 文件。
- 包含图表的 Canvas HTML 会内嵌固定版本的 ECharts runtime，因此文件大约会增加 1.1 MB。它会运行内嵌 JavaScript 来保留图表交互，但不会发起网络请求，也无法访问 Stela IPC、数据库连接或源 Vault。
- Demo Vault 的已保存结果可以直接浏览。只有重新执行内置 MySQL 查询时才需要 Docker；只有体验真实 Agent 和新增 Dashboard 活跃记录时才需要配置 AI Provider。在同一个目标位置重新创建 Demo 只会补齐缺失文件，不会覆盖你已经编辑过的内容。
