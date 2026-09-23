# Stela v0.16.0

## English

### Highlights

- **SQL in Chat:** Write SQL, ask questions, or combine both in a saved conversation. SQL-only input runs directly; failed queries can enter the Agent repair flow. Continue analyzing results, create charts in the conversation, and organize findings in a Canvas.
- **One composer for Chat and Agent:** SQL highlighting, schema completion, formatting shortcuts, and `@` references to notes, Canvas files, and SQL blocks. Conversations retain drafts and context when moved between a tab and the side panel.
- **Clearer analysis and reports:** A more compact conversation timeline groups execution details. Canvas charts and flow diagrams render more reliably, diagrams fit their container, and generated Canvas content is validated before saving. Reports can be exported as HTML.
- **Reusable knowledge:** Background maintenance uses verified sources to update reusable knowledge. Maintenance outcomes are visible, and saved knowledge can be opened for review.

### Improvements

- Upgraded Pi to 0.87.0 for its updated model catalog and provider support. Existing model profiles and locally stored credentials remain in use.
- Improved cancellation, bounded generation recovery, and conversation persistence. Retrying a model response does not replay completed tools.
- Added Custom OpenAI Responses support alongside Chat Completions, and improved language consistency in generated content.
- Completed Chinese translations across navigation, settings, and common actions. Shortened AI, plugin, and privacy explanations while keeping permission and data-sharing information.
- Refreshed the bilingual website and README with product screenshots. Windows x64 and macOS Apple Silicon downloads now have stable filenames for permanent download links.

### Upgrade Notes

- Existing Agent conversation history remains readable. Continuing a previous Agent conversation automatically upgrades its storage format and retains a pre-upgrade backup.
- Notes, database connections, and model credentials do not require manual migration. Interrupted Agent operations are not automatically replayed.
- Experimental semantic cost and analysis-scope options remain optional. Batch semantic analysis still requires authorization and respects task budgets.

## 中文

### 重点更新

- **SQL 对话：** 在可保存的对话中编写 SQL、描述问题，或混合输入。纯 SQL 可直接执行，查询失败后可由 Agent 协助修正。围绕结果继续分析，在对话中生成图表，并将结论整理为 Canvas 报表。
- **统一输入框：** Chat 与 Agent 共用 SQL 高亮、表结构补全、格式化快捷键，以及笔记、Canvas 和 SQL 块的 `@` 引用。对话在标签页与侧边面板之间切换时保留草稿和上下文。
- **更清晰的分析与报表：** 对话时间线更紧凑，执行细节集中展示。修复 Canvas 图表和流程图的显示问题，流程图适应容器大小，生成内容在保存前经过校验。报表可导出为 HTML。
- **可复用的知识：** 后台维护依据已核实的来源整理知识，维护结果可见，已保存的知识可打开查看。

### 改进

- Pi 升级至 0.87.0，更新模型目录与提供商支持，继续使用已有模型配置及本地凭据。
- 改进取消、模型响应重试和对话保存。重试模型响应不会重复执行已完成的工具。
- 自定义 OpenAI 接口新增 Responses 支持，与 Chat Completions 并存；改善生成内容的语言一致性。
- 补齐导航、设置和常用操作的中文翻译，精简 AI、插件与隐私说明，保留必要的权限和数据发送提示。
- 更新双语官网、README 和产品截图。Windows x64 与 macOS Apple Silicon 安装包新增固定文件名，供官网下载链接长期使用。

### 升级说明

- 已有 Agent 历史会话仍可查看，继续使用时会自动升级存储格式，并保留升级前的备份。
- 笔记、数据库连接和模型凭据无需手动迁移。被中断的 Agent 操作不会自动重放。
- 语义成本与分析口径的实验选项仍为可选功能。批量语义分析继续遵循授权范围和任务预算。
