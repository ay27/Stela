# Stela

![icon](./stela_icon_rounded.png)

**Run SQL in Markdown. Track data in Stela.**

[English](#english) | [中文](#中文)

## English

Stela is a local-first desktop app for data notes. It lets you write Markdown, run SQL where the data question appears, keep every execution traceable, and turn a folder of notes into a lightweight data workspace.

![overview](./docs/assets/preview.png)

### 1. Run SQL in Markdown

Use `runsql` blocks inside normal Markdown files. A note can mix prose, assumptions, query context, and executable SQL in one place.

````markdown
```runsql
SELECT status, COUNT(*) AS total
FROM tasks
GROUP BY status;
```
````

Stela can connect to multiple databases through connector plugins. The open-source version includes bundled connectors for MySQL and PostgreSQL, plus a generic HTTP gateway sample for custom data backends.

![connections](./docs/assets/connections.png)

### 2. Execution History and Result Diff

Every run is recorded. You can revisit previous executions, inspect result metadata, and compare result changes over time.

This makes a data note more than a static query snippet:

- See when a query was run.
- Compare current results with previous runs.
- Keep failed runs visible for debugging.
- Export a result without losing the surrounding analysis.

![history-diff](./docs/assets/diff.png)

### 3. Git Sync and History Management

Stela is built around a Git-friendly vault model. Your notes stay as Markdown, and execution history is stored as append-only JSONL files under `.stela/history/`.

That means your analytical work can be tracked clearly over time:

- Notes are plain `.md` files.
- Run history can be committed and synced.
- Local SQLite is only a rebuildable cache.
- Git history gives you a timeline of how analysis evolved.

![git-sync](./docs/assets/git.png)

![git-sync2](./docs/assets/git-sync.png)

### 4. Markdown Compatibility and Data Export

Stela notes remain standard Markdown files. You can open them in editors like VS Code, GitHub, Obsidian, or any Markdown viewer. The `runsql` block still appears as a normal fenced code block outside Stela.

When you need to share results, Stela supports exporting data from executed blocks instead of forcing everything into the note body.

Typical uses:

- Keep the note readable.
- Export query results for reporting.
- Share Markdown without requiring Stela.
- Preserve a lightweight summary in the note and full data locally.

![export](./docs/assets/export.png)

The screenshot for export results:

![export-result](./docs/assets/export-result.png)

### 5. Standard Bidirectional Markdown Notes

Stela is also a Markdown note app with standard wiki-style links. Use `[[links]]` to connect notes, build context around datasets, and keep a navigable knowledge base around your analysis.

Data work rarely lives in one file. Stela helps connect:

- Dataset notes
- Query notes
- Investigation logs
- Decision records
- Reusable SQL snippets


### Why Stela

Stela is for people who want SQL, Markdown, and versioned analytical history in the same local workspace.

It is not trying to replace a database, a BI platform, or a full notebook system. It focuses on the layer where analysts, engineers, and researchers explain what they are doing, keep the query near the reasoning, and make the work traceable over time.

## 中文

Stela 是一个本地优先的数据笔记桌面应用。你可以写普通 Markdown，在提出数据问题的地方直接运行 SQL，保留每一次执行痕迹，并把一个笔记文件夹变成轻量的数据工作台。

![overview](./docs/assets/preview.png)

### 1. 在 Markdown 里运行 SQL

Stela 支持在普通 Markdown 文件中插入 `runsql` 代码块。一篇笔记可以同时包含文字说明、分析假设、查询背景和可执行 SQL。

````markdown
```runsql
SELECT status, COUNT(*) AS total
FROM tasks
GROUP BY status;
```
````

Stela 通过 connector 插件连接多种数据库。开源版本默认包含 MySQL、PostgreSQL，以及一个通用 HTTP Gateway sample，方便接入自定义数据后端。

![connections](./docs/assets/connections.png)

### 2. 执行历史与结果对比

每一次 SQL 执行都会被记录。你可以回看历史执行、查看结果元信息，并对比不同时间的结果变化。

这让数据笔记不只是静态 SQL 片段：

- 查看查询何时运行。
- 对比当前结果和历史结果。
- 保留失败执行，方便排查问题。
- 导出结果时不丢失上下文说明。

![history-diff](./docs/assets/diff.png)

### 3. Git 同步与历史管理

Stela 围绕 Git 友好的 vault 模型设计。笔记保持为 Markdown，执行历史以 append-only JSONL 存放在 `.stela/history/` 下。

这意味着分析过程可以被清晰地版本化：

- 笔记是普通 `.md` 文件。
- 执行历史可以随 Git 提交和同步。
- 本地 SQLite 只是可重建缓存。
- Git 历史记录了分析如何一步步演进。

![git-sync](./docs/assets/git.png)

![git-sync2](./docs/assets/git-sync.png)

### 4. Markdown 全兼容与数据导出

Stela 笔记保持标准 Markdown 格式。你可以用 VS Code、GitHub、Obsidian 或任何 Markdown 工具打开它们。离开 Stela 后，`runsql` 也只是普通 fenced code block。

当需要分享结果时，Stela 支持从已执行 block 导出数据，而不是把完整结果强行塞进笔记正文。

典型用途：

- 保持笔记轻量可读。
- 导出查询结果用于报告。
- 分享 Markdown 时不强依赖 Stela。
- 笔记内保留摘要，完整数据留在本地。

![export](./docs/assets/export.png)

导出结果截图：

![export-result](./docs/assets/export-result.png)

### 5. 标准双链 Markdown 笔记

Stela 也是一个支持标准 wiki-style links 的 Markdown 笔记应用。你可以用 `[[links]]` 连接笔记，为数据集、查询和分析过程建立上下文网络。

数据工作通常不会只存在于一个文件里。Stela 可以连接：

- 数据集说明
- 查询笔记
- 排查日志
- 决策记录
- 可复用 SQL 片段

### 为什么是 Stela

Stela 面向希望把 SQL、Markdown 和可追踪分析历史放在同一个本地工作区的人。

它不试图替代数据库、BI 平台或完整 notebook 系统。它专注于分析者真正写下思考的那一层：把查询放在推理旁边，把结果历史留住，让数据工作随时间可追踪。
