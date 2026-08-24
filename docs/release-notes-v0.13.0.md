# Stela v0.13.0

Compared with v0.12.0, this release makes long Agent workflows easier to control and inspect, replaces partial Canvas data refresh with atomic Agent-led re-analysis, and adds native multi-block editing to Markdown notes.

## English

### Highlights

- **Multi-block Markdown editing:** Drag through the editor gutter to select complete paragraphs, headings, lists, RunSQL blocks, tables, and other blocks as one range. The selection works with copy, cut, delete, replacement, undo, and drag-and-drop instead of falling back to an incomplete browser text selection.
- **Atomic Agent-led Canvas refresh:** Whole-Canvas and single-source refresh actions now open a dedicated Agent run. The Agent reruns the relevant queries, re-evaluates dependent KPI, chart, table, narrative, and flow content, and commits the Canvas only after every targeted source has a successful audited result from that run.
- **Controllable model reasoning:** Every AI profile has a reasoning-effort setting from `off` through `max`, constrained to the selected built-in model's supported levels. Agent Dashboard records requested and effective effort so runs and DataAgentBench results remain comparable.
- **Visible Agent progress:** Ordinary model-step narration appears while a long run is in progress, without exposing hidden reasoning or tool-call payloads. The last process message becomes the final answer in place, while earlier process messages and strategy reviews collapse after completion.
- **Action-oriented execution traces:** Agent Dashboard focuses its trajectory on model calls, tool executions, approvals, strategy reviews, and context compaction. Model details now own readable input and output, token usage, cache tokens, context-window occupancy, reasoning effort, status, and timing.

### Improvements

- **Faster live schema lookup:** Schema retrieval prefers a connector's direct multi-table describe capability and falls back safely when a connector does not implement it, reducing repeated remote round trips.
- **More focused Agent behavior:** The system prompt now follows a compact evidence hierarchy and conditional analysis workflow. Routine lookup, schema, and query tasks avoid unnecessary planning, retrieval, and adjacent investigation.
- **Safer Skill discovery and maintenance:** Skills are classified as fresh, stale, or untracked. Routine discovery hides stale entries, while explicit knowledge maintenance can inspect old drafts, verify them against live evidence, and save source-bound replacements.
- **Useful Agent empty state:** The empty Agent Panel offers context-aware actions for creating or refreshing a Canvas, summarizing or auditing the current document, and maintaining the knowledge library.
- **Cleaner maintenance UX:** Skill listing and search share one paginated interface, knowledge maintenance no longer injects every Skill summary into the initial prompt, and stale Skills fail early without biasing routine Agent work.

### Upgrade Notes

- No manual data migration is required when upgrading from v0.12.0. Existing notes, Canvas files, SQL templates, connections, execution history, Agent history, and Skills remain readable.
- Existing AI profiles without a saved reasoning-effort value default to `medium`. Custom OpenAI-compatible endpoints must support the standard `reasoning_effort` field when a non-`off` level is selected; otherwise select `off` for that profile.
- The Canvas file schema remains version 1. Refresh now requires an available model and connection and may take longer than direct SQL-only refresh, but a failed target query leaves the Canvas unchanged.
- Completed process narration is stored in bounded device-local Agent history. Streaming token fragments and hidden reasoning are not persisted as conversation events, and the existing history-retention policy is unchanged.

## 中文

### 重点更新

- **Markdown 多块编辑：** 在编辑器边缘拖动，可将段落、标题、列表、RunSQL Block、表格等完整内容块选为一个范围。选区可直接复制、剪切、删除、替换、撤销和拖放，不再退化为不完整的浏览器文本选区。
- **Agent 原子刷新 Canvas：** 整个 Canvas 和单一数据源的刷新都会启动专用 Agent 任务。Agent 重新执行相关查询，并重新评估 KPI、图表、表格、说明和流程内容；只有当所有目标数据源都绑定到本轮审计通过的成功结果后，才会一次性更新 Canvas。
- **可控的模型 Reasoning：** 每个 AI Profile 都可选择从 `off` 到 `max` 的 Reasoning Effort，内置模型会限制为其实际支持的强度。Agent Dashboard 会记录请求强度和实际强度，便于对比不同运行与 DataAgentBench 结果。
- **可见的 Agent 执行进度：** 长任务执行时会展示模型各步产生的普通过程说明，但不暴露隐藏 Reasoning 或工具调用参数。最后一条过程消息会原位升级为最终回答，早期过程消息和策略复盘在完成后默认折叠。
- **面向动作的执行轨迹：** Agent Dashboard 的主轨迹专注于模型调用、工具执行、用户审批、策略复盘和上下文压缩。模型步骤详情会统一展示可读的输入输出、Token 用量、Cache Token、Context Window 占用、Reasoning 强度、状态和耗时。

### 改进

- **更快的实时 Schema 查询：** Schema 获取优先使用 Connector 直接提供的多表 Describe 能力；Connector 未实现时会安全回退，从而减少重复的远程往返。
- **更聚焦的 Agent 行为：** System Prompt 改为精简的证据层级和按需执行的分析流程。常规的定位、Schema 检查和查询任务会减少不必要的计划、检索和旁支调查。
- **更安全的 Skill 发现与维护：** Skill 会被分为 fresh、stale 和 untracked 三种状态。日常发现会隐藏 stale 条目；显式的知识维护任务则可以查看旧草稿，用实时证据验证后保存绑定来源的替代内容。
- **更实用的 Agent 空白状态：** Agent Panel 会根据当前文档提供创建或刷新 Canvas、总结或审查当前文档、整理知识库等可直接执行的入口。
- **更干净的知识维护体验：** Skill 列表与搜索合并为一个可分页接口，知识维护不再把所有 Skill 简介注入初始 Prompt，stale Skill 也不会再干扰日常 Agent 工作。

### 升级说明

- 从 v0.12.0 升级无需手动迁移数据。现有笔记、Canvas、SQL 模板、数据库连接、执行历史、Agent 历史和 Skill 均可继续读取。
- 没有保存 Reasoning Effort 的现有 AI Profile 会默认使用 `medium`。当 Custom OpenAI-compatible Endpoint 选择非 `off` 强度时，需要支持标准 `reasoning_effort` 字段；如果不支持，请将该 Profile 设为 `off`。
- Canvas 文件 Schema 仍为版本 1。刷新现在依赖可用的模型和数据连接，可能比仅执行 SQL 更慢，但任一目标查询失败都不会修改 Canvas。
- 完成的过程说明会保存到有界的本机 Agent 历史中。流式 Token 片段和隐藏 Reasoning 不会作为对话事件持久化，现有历史保留策略不变。
