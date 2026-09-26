# Stela v0.17.0

## English

### Highlights

- **Experimental privacy mode:** Opt in to local masking of query text values and numeric values whose purpose is unknown, including values inside JSON, before model analysis. Conversation-specific placeholders stay consistent across turns, while local replies and result tables display the originals. No separate model download or Python installation is required for masking.
- **Control which data is shared:** When analysis needs original values, review column or JSON-field access requests together, with approve-all and reject-all actions. Approval applies only to the specified query result and current task; Python analysis follows the same permissions. Proven SQL counts remain usable without releasing an entire column.
- **More data sources:** Added connectors for StarRocks, Apache Doris, SQLite, DuckDB, ClickHouse, Trino, SQL Server, BigQuery, Snowflake and Databricks. DuckDB can query explicitly selected CSV, Parquet, JSON and JSONL files. Connection settings include guidance for cloud authentication.

### Improvements

- Chat and RunSQL share compact result controls: connection, duration and result size in one header, export actions in a menu, and pagination only when needed. Chat also offers a SQL disclosure and reuse action.
- Result-column headers use a thin purple underline when masking was observed, with explanations for partial masking. Local tables and exports retain original values; direct SQL results without model processing are not marked as masked.
- Improved result-cell selection, keyboard navigation, copying and horizontal scrolling. Refined workbench styling and reduced whitespace around conversation dividers.
- Create notes or folders from a file's context menu or the new button beside the file-tree filter. The target directory is shown, and the name input is revealed automatically, including in long or filtered lists.
- Improved Agent context compaction, generation retries and usage reporting by reusing the Pi runtime's handling. Fixed restoration of masked reply text across subsequent timeline updates and reduced placeholder length.

### Upgrade Notes

- No manual migration is required for notes, connections or model profiles. Existing conversations without column-masking metadata remain readable and do not acquire inferred privacy markers.
- Privacy mode is optional and experimental. It reduces data sent to models; it does not guarantee anonymity. Free text, schema metadata and other context do not have complete coverage. Masked names and unknown numeric values may require explicit release for semantic analysis or arithmetic.
- Saved privacy-mode conversations contain reversible mappings and may follow the vault's Git sync. Treat these files as containing original data. Data explicitly released to a model cannot be recalled, even after the task's permission expires.
- Cloud connectors require an appropriately configured account, permissions and query-cost controls. Bundled adapters and local tests do not replace validation against your own cloud account.
- Release builds target macOS Apple Silicon and Windows x64. Stable installer download links remain unchanged.

## 中文

### 重点更新

- **实验性隐私模式：** 可选择在本地遮蔽查询结果中的文本、用途未确认的数值及 JSON 内部值，再交给模型分析。随机占位符在同一多轮会话中保持一致，本地回复和结果表格恢复显示原值。脱敏无需额外下载模型或安装 Python。
- **自行控制数据放行：** 当分析需要原值时，可集中审阅列或 JSON 字段的访问请求，支持全部通过、全部拒绝。授权仅适用于指定查询结果和当前任务，Python 分析遵循相同权限。经过验证的 SQL 计数保持可用，无需放开整列。
- **更多数据源：** 新增 StarRocks、Apache Doris、SQLite、DuckDB、ClickHouse、Trino、SQL Server、BigQuery、Snowflake 和 Databricks 连接器。DuckDB 可查询用户明确选取的 CSV、Parquet、JSON 和 JSONL 文件；连接设置提供云端认证配置说明。

### 改进

- Chat 与 RunSQL 共用精简结果表格：连接、耗时、结果大小集中在一行，导出操作收进菜单，仅在需要时显示分页。Chat 另提供 SQL 展开与复用操作。
- 对已观察到脱敏的结果列，在表头显示细紫色下划线，并说明部分脱敏状态。本地表格和导出继续保留原值；未经模型处理的直接 SQL 结果不会被标为已脱敏。
- 改进结果单元格选择、键盘导航、复制和横向滚动，调整工作区样式并收紧对话分割线附近的留白。
- 支持在文件右键菜单或文件树过滤栏旁的「新建」按钮中创建笔记、子目录。菜单注明目标目录，长列表或过滤状态下也会自动显示名称输入框。
- 复用 Pi 运行时的上下文压缩、生成重试和用量统计。修复后续时间线更新影响回复反脱敏的问题，缩短占位符以减少 token 开销。

### 升级说明

- 笔记、数据库连接和模型配置无需手动迁移。旧会话仍可读取；缺少列脱敏记录的历史结果不会被推测性地添加隐私标记。
- 隐私模式为可选实验功能，用于减少发给模型的数据，不保证匿名。自由文本、schema 元数据及其他上下文尚未完整覆盖。对被遮蔽的名称或用途未确认的数值进行语义分析、算术计算时，可能需要明确放行。
- 保存的隐私模式会话含有可逆映射，可能随仓库 Git 同步，应按包含原始数据的文件管理。明确放行给模型的数据无法撤回，即使当前任务的授权已经过期。
- 云端连接器需要配置相应账号、权限及查询成本限制。内置适配器与本地测试不能替代在实际云账号上的验证。
- 发版安装包面向 macOS Apple Silicon 和 Windows x64，固定下载链接保持不变。
