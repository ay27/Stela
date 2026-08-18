# Stela v0.12.0

Compared with v0.11.0, this release makes the Data Agent substantially more capable and inspectable. It can work across SQL and MongoDB sources, analyze larger query artifacts in a sandboxed Python runtime, keep ordered resource references in the conversation, and expose its session-level execution path in Agent Dashboard.

## English

### Highlights

- **Sandboxed Python data analysis:** The Agent can use Pyodide with DuckDB, pandas, and NumPy to calculate statistics, join query artifacts, and inspect data that would be too large or awkward to pass through chat text. The runtime is bundled with Stela, requires no system Python installation, and runs without host filesystem or network access.
- **Session-scoped query artifacts:** Read-only SQL and MongoDB queries can retain bounded local artifacts for later Agent steps. Python analysis reads those artifacts by session alias, so results from different connections can be combined without embedding full datasets in model messages or durable Canvas files.
- **MongoDB and structured read-only queries:** MongoDB joins MySQL and PostgreSQL as a bundled connector. The Agent uses one structured read-only query interface for SQL statements and MongoDB aggregation pipelines, with connector-aware validation and existing mutation approval boundaries kept intact.
- **Session-oriented Agent Dashboard:** Inspect a session by turn, scan the full-width execution waterfall, and select model or tool steps to view formatted payloads, results, status, and timing. Cache-hit telemetry is included so prompt-cache improvements can be measured rather than assumed.
- **Ordered Agent composer:** The Agent input now uses ProseMirror. Tables, notes, Canvas files, and RunSQL blocks stay as inline resource pills at the exact position where they were mentioned, while the currently open tab is supplied as implicit context without adding repetitive visible pills.

### Improvements

- **Prompt-cache-friendly requests:** Stable Agent instructions are kept ahead of turn-specific context, supported providers receive cache-retention hints, and sessions keep a stable cache identity. This improves latency and token cost when the provider supports prompt caching.
- **Agent quick actions:** RunSQL rewrite, question, and error-repair actions open the Agent Panel and reliably insert their prepared message. SQL repair includes the execution error instead of sending the query alone.
- **Adaptive strategy review:** Repeated or low-yield query patterns can trigger one bounded, tool-free strategy checkpoint. The Agent either continues with explicit justification or changes direction, reducing time spent circling around similar attempts.
- **Analysis efficiency:** The Agent reuses validated query evidence, reviews repeated query families, and records efficiency diagnostics used by DataAgentBench. Failed runs now retain usage data where the provider reports it.
- **Dashboard readability:** Session lists use a narrower navigation column and a wider details pane. String payloads preserve line breaks, JSON payloads and results wrap long values, and low-value truncated summary panels have been removed.
- **Model and connection controls:** The Agent model selector is wider and switches profiles through one validated settings path. Settings can open the new-connection form reliably.
- **Cross-platform packaging:** Pyodide assets are prepared before builds and copied with Windows-safe normalized glob paths.

### Upgrade Notes

- No manual migration is required when upgrading from v0.11.0. Existing notes, Canvas files, SQL templates, connections, AI profiles, execution history, and Agent history remain compatible.
- Stela now bundles approximately 31 MB of Pyodide runtime and Python package assets before installer compression. This enables `execute_python` without a local Python environment and increases the packaged application size.
- Python inputs are temporary, session-scoped query artifacts rather than Vault documents. They are not intended for Git synchronization; if an artifact is no longer available, rerun its source query before using it in Python.
- Prompt-cache savings depend on the selected provider and model. Agent Dashboard reports cache reads when the provider exposes them; a zero rate does not imply a local Stela error.

## 中文

### 重点更新

- **沙箱 Python 数据分析：** Agent 可以通过 Pyodide 使用 DuckDB、pandas 与 NumPy 进行统计计算、关联查询产物，并检查不适合完整塞进对话文本的大规模数据。运行时随 Stela 一起提供，无需安装系统 Python，也无法访问宿主文件系统和网络。
- **会话级查询产物：** 只读 SQL 与 MongoDB 查询可以为后续 Agent 步骤保留有界的本地临时产物。Python 分析通过会话别名读取这些产物，因此可以组合不同连接的结果，而无需把完整数据集放进模型消息或持久化 Canvas 文件。
- **MongoDB 与结构化只读查询：** MongoDB 现在与 MySQL、PostgreSQL 一样作为内置连接器提供。Agent 使用统一的结构化只读查询接口执行 SQL 语句和 MongoDB 聚合管道，同时保留针对不同连接器的校验以及现有的数据修改审批边界。
- **按会话组织的 Agent Dashboard：** 可以按 Turn 检查会话，通过横跨顶部的执行时间线浏览全局过程，再选择模型或工具步骤查看格式化参数、结果、状态和耗时。Dashboard 还会记录缓存命中指标，让 Prompt Cache 优化可以被实际衡量。
- **有序的 Agent 编辑器：** Agent 输入框改用 ProseMirror。表、笔记、Canvas 与 RunSQL Block 会作为内联资源 Pill 保留在用户提及它们的准确位置；当前打开的标签页则作为隐式上下文提供，不再重复增加显式 Pill。

### 改进

- **适配 Prompt Cache 的请求结构：** 稳定的 Agent 指令位于每轮动态上下文之前；支持的 Provider 会收到缓存保留提示；同一会话保持稳定的缓存身份。Provider 支持 Prompt Cache 时，可以降低延迟与 Token 成本。
- **Agent 快捷操作：** RunSQL 改写、问询和错误修复操作会打开 Agent Panel，并可靠地插入准备好的消息。修复 SQL 时会同时提供执行错误，而不再只发送 SQL。
- **自适应策略复核：** 重复或低收益的查询模式可以触发一次有界且不调用工具的策略检查。Agent 需要明确说明继续理由或改变方向，减少围绕相似尝试反复打转。
- **分析效率：** Agent 会复用已经验证的查询证据，检查重复查询族，并记录供 DataAgentBench 使用的效率诊断；如果 Provider 提供 Usage，失败运行也会保留相关统计。
- **Dashboard 可读性：** 会话事件列表改为更窄的导航栏，详情面板得到更大空间。字符串参数保留换行，JSON 参数和结果会对长内容自动折行，并移除了价值较低且经常被截断的摘要面板。
- **模型与连接控制：** Agent 模型选择器更宽，并通过单一、经过校验的设置链路切换配置；设置面板也可以可靠地打开新建连接表单。
- **跨平台打包：** 构建前会准备 Pyodide 资源，并使用兼容 Windows 的规范化 Glob 路径完成复制。

### 升级说明

- 从 v0.11.0 升级无需手动迁移。已有笔记、Canvas、SQL 模板、数据库连接、AI 配置、执行历史和 Agent 历史保持兼容。
- Stela 现在会在安装包压缩前携带大约 31 MB 的 Pyodide 运行时和 Python 包资源。这使 `execute_python` 不依赖本地 Python 环境，但也会增加应用包体积。
- Python 输入是按会话管理的临时查询产物，不是 Vault 文档，也不用于 Git 同步；如果产物已经不可用，需要先重新执行来源查询，再在 Python 中使用。
- Prompt Cache 的收益取决于所选 Provider 和模型。只有 Provider 返回相关统计时，Agent Dashboard 才能显示缓存读取；命中率为零不一定表示 Stela 本地出现错误。
