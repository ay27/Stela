# Stela v0.15.0

Compared with v0.14.0, this release adds reusable Python analysis workspaces and bounded batch semantic operations, restores automatic knowledge maintenance with visible failure reporting, and improves source-file editing and Agent recovery.

## English

### Highlights

- **Stateful Python analysis workspaces:** Variables, DataFrames, and source snapshots can be reused across Agent calls within the same session. The panel exposes workspace state and source snapshot metadata. Omitting `sources` reuses existing inputs; redeclaring an alias refreshes that source without silently changing previously computed DataFrames.
- **Bounded batch semantic analysis:** Python analysis can request classification, structured extraction, and conservative entity resolution through host-mediated semantic helpers. Model selection, authorization, shared run budgets, caching, and cancellation remain under host control. Failed, unresolved, and unprocessed records stay explicit rather than being counted as successful results.
- **Automatic knowledge maintenance restored:** Fixed a missing import that stopped background maintenance before model execution. Initialization and model errors now reach terminal metrics. Failures and limits are visible beside the completed answer, with redacted diagnostic details and background outcomes retained in conversation history.
- **Readable source-file editing:** Supported text formats such as SQL and Python open in a CodeMirror source editor with preserved line breaks, syntax support, and word wrapping. Opening Agent Panel no longer hides the document table of contents; recent editor spacing improvements are retained.

### Improvements

- **Clearer query-to-Python handoff:** Full-result analysis uses declarative read-only `sources` rather than model-managed artifacts or direct Python `query()` calls. Source declarations and workspace errors provide actionable feedback while previews and result JSON remain bounded.
- **Safer long-running Agent recovery:** Active reasoning is not cut off by a blanket three-minute generation deadline. Transient generation retries are bounded and do not replay completed tools. When eligible, a separate tool-free closeout uses committed evidence; any partial answer retains the original execution failure instead of reporting success.
- **More observable analysis:** Context usage and workspace status are visible in Agent Panel. Exact-answer checks distinguish complete evidence from incomplete semantic batches, and maintenance skips, cancellation, time limits, and errors are no longer conflated with "no update needed."
- **Consistent SQL inline completion:** Completion uses the configured chat transport for all profiles, retaining prefix/suffix context and validation instead of selecting a separate native FIM path for one provider.
- **Regression coverage and release safeguards:** Added maintenance save/readback, failure, history, and redaction tests, plus an Electron unresolved-symbol/import build gate. DAB tooling also gains failed-case reruns and richer comparison diagnostics; these changes do not imply a benchmark accuracy improvement.

### Upgrade Notes

- This release does not require a manual Vault data migration. Existing notes, Canvas files, connections, execution history, Agent history, and Skills remain supported. Legacy maintenance records without an explicit outcome are displayed as unknown rather than assumed successful.
- Python workspaces are disposable session state, not durable notebooks. Restarting the app, resetting or evicting a workspace, or cancellation can lose variables and cached work. Source aliases are DuckDB relations accessed through `tables[alias]`; use `to_df(alias)` for pandas. The reserved `result` value is cleared before each cell, so retain reusable values under other names.
- Semantic operations may send selected input columns to the configured model provider and incur inference costs. Review the authorization scope and budgets; cache reuse and schema validation do not guarantee semantic correctness or complete dataset coverage.
- Automatic knowledge maintenance still respects its settings toggle and verified-source requirements. Historical failed maintenance jobs are not automatically replayed by this upgrade.
- SQL inline completion no longer uses the v0.14.0 provider-specific native FIM route. Custom Python instructions should use declarative `sources` and workspace helpers rather than the old `query()` interface.
- The new Electron symbol/import gate is not a claim that the entire main process passes strict typechecking. Build parallelization and incremental-check caching are not included in this release.

## 中文

### 重点更新

- **有状态 Python 分析工作区：** 同一 Agent 会话内可跨调用复用变量、DataFrame 和来源快照，面板可查看工作区状态及快照元数据。省略 `sources` 会复用已有输入；重新声明别名只刷新对应来源，不会悄悄改动之前计算出的 DataFrame。
- **有边界的批量语义分析：** Python 分析可通过宿主提供的语义接口执行分类、结构化抽取和保守实体归并。模型选择、授权、共享执行预算、缓存和取消由宿主管理；失败、未决和未处理记录会明确保留，不会被当作成功结果。
- **恢复自动知识维护：** 修复了缺失导入导致后台维护在调用模型前中断的问题。初始化和模型错误现在都会记录终态；失败及达到限额会显示在已完成回答下方，可展开查看脱敏诊断，后台结果也会保留在对话历史中。
- **更易读的源文件编辑：** SQL、Python 等受支持的文本格式使用 CodeMirror 源码编辑器，保留换行、提供语法支持并自动折行。打开 Agent Panel 不再隐藏主文档目录，同时保留近期的编辑区间距改进。

### 改进

- **更明确的查询到 Python 数据链路：** 全量结果分析使用声明式只读 `sources`，不再要求模型管理 artifact 或直接调用 Python `query()`。来源声明和工作区错误提供可操作的反馈，预览及结果 JSON 保持大小边界。
- **更安全的长任务恢复：** 不再以统一的三分钟生成超时截断仍在进行的推理。瞬时生成故障采用有边界的重试，不重放已完成的工具调用。满足条件时，独立的无工具收尾只使用已提交证据；即使交付部分答案，也保留原始执行失败状态。
- **更清晰的分析状态：** Agent Panel 展示上下文使用量与工作区状态。精确答案检查区分完整证据和未完成的语义批次；知识维护的跳过、取消、达到限额与错误不再被混称为“无需更新”。
- **统一 SQL 行内补全：** 所有 Profile 使用配置的 Chat Transport，保留前后缀上下文与结果校验，不再为单个提供商选择独立的原生 FIM 路径。
- **回归覆盖与发布防护：** 新增知识保存读回、异常收尾、历史记录和脱敏测试，并在构建时检查 Electron 未定义符号及错误导入。DAB 工具补充失败用例复跑和更丰富的对比诊断；这些改动不代表基准准确率已经提升。

### 升级说明

- 本次升级无需手动迁移 Vault 数据，现有笔记、Canvas、连接、执行历史、Agent 历史和 Skill 仍受支持。缺少明确维护结果的旧记录会显示为未知，不再假定维护成功。
- Python 工作区是可丢弃的会话状态，不是持久化 Notebook。应用重启、工作区重置或回收，以及取消操作都可能丢失变量和缓存。来源别名对应 DuckDB relation，通过 `tables[alias]` 访问；需要 pandas 时使用 `to_df(alias)`。保留字段 `result` 会在每个单元执行前清除，可复用的值应另取变量名保存。
- 语义操作可能将选中的输入列发送给配置的模型提供商，并产生推理费用。请确认授权范围和预算；缓存命中、结构校验不等于语义正确，也不保证覆盖完整数据集。
- 自动知识维护仍受设置开关和可信来源要求约束；升级不会自动重放历史失败的维护任务。
- SQL 行内补全不再使用 v0.14.0 中的提供商专用原生 FIM 路径。自定义 Python 使用说明应采用声明式 `sources` 和工作区辅助函数，不再依赖旧的 `query()` 接口。
- 新增的 Electron 符号／导入检查不代表主进程已通过完整严格类型检查。构建并行化和增量检查缓存尚未包含在本版中。
