# Python 工作区与批量语义能力验收

日期：2026-09-05。对应 ADR-0089 / ADR-0090。

## 验收结论的边界

自动化测试使用临时目录、合成数据、假模型响应和测试授权，不访问用户 Vault、
真实数据库或模型服务，也不会保存用户的授权。模型返回被控制，因而只证明
链路与约束正确，**不证明真实模型的分类准确率或 DAB 得分提升**。

桌面可见弹窗、设置交互和进度显示须单独人工确认，不应把离线服务测试写成
“Agent Panel 端到端实测通过”。本次新增的人工项均尚未执行。

## 自动化入口

```bash
npm run test:semantic-workflow
npm run test:python-workspace
npm run test:semantic
node --import tsx electron/services/ai/agent-tools.test.ts
node --import tsx electron/services/ai/python-runtime-broker.test.ts
```

`test:semantic-workflow` 的实际路径：

```text
真实 load_skill / execute_python
→ 主进程 Python job broker
→ 模拟桌面消息运输 + 真实 Pyodide Worker / Python helper
→ 按 jobId 校验的 semanticForPythonJob
→ createSemanticAgent / 本地授权记录 / 预算 / 缓存
→ 真实 provider 序列化 + 模拟 HTTP 流式响应
→ Python 结构化结果 → 工具返回
```

| 自动化检查 | 必须满足的断言 |
|---|---|
| 能力发现 | Python 工具描述列明分类、抽取、实体匹配；真实加载 semantic-analysis System Skill |
| 无数据库 | 合成 DataFrame 可执行，连接查询不得被调用 |
| 最小发送范围 | 未选择的 private 列不能进入子模型请求 |
| 模型选择 | 指定语义 profile 时不用主模型；未指定时跟随主模型 |
| 授权 | 首次请求触发授权回调；同接收端授权复用；预算增加须再次授权；拒绝不得发送数据 |
| 缓存 | 跨 cell / Agent run 复用；reset 清缓存但不撤授权；缓存不得绕过撤销后的授权 |
| 分类 / 抽取 | 两行分类成功；结构化抽取返回受 schema 验证的 amount |
| 保守实体匹配 | A=B、B=C、A≠C 不得生成自动归并实体 |
| 预算 | 只允许 1 条记录时第二条标 unprocessed；换 cell / instructions 不重置预算 |
| 取消 | 等待授权时取消不发数据；请求进行中取消传到子模型和 Worker |
| 生命周期 | 过期 jobId 不能再次调用语义服务；使用已丢失工作区先收到 workspace_lost |

`test:python-workspace` 另外验证：变量保留、普通异常后的部分修改、每格清理
result、来源从 10 刷新为 30 而旧 DataFrame 仍为 10，以及取消后真实 Worker
销毁、显式重建。桌面运行时测试模拟 Worker error 和 LRU 淘汰事件，验证丢失
通知、迟到结果隔离和新 Worker 不自动回放旧代码。

## 三条不能混淆的契约

1. **别名不是变量**：来源 alias=t 应使用 `tables['t']`（DuckDB relation）或
   `t_df = to_df('t')`（pandas）。`t['a']` 的 NameError 不表示工作区丢失。
2. **result 不是持久变量**：每格开始都会删除它；与来源刷新无关。需要保留
   的计算请命名为 total / classified 等，再 `result = total`。末尾表达式
   不等于结构化输出。
3. **reset 不等于意外丢失**：主动清空后 NameError 只验收 reset。测试意外丢失
   必须看到 workspace_lost，并确认随后仅执行显式重建代码，不自动重查来源。

## Agent Panel 人工验收（尚未执行）

先重启加载最新本地代码。使用独立测试会话及测试 Vault；以下模型调用只有在
用户确认授权后才能执行。不要使用真实业务文本，也不要让 Agent 自动批准。
已有授权可能使弹窗不出现；需要测试首次授权时，在设置中由用户手动撤销，
注意撤销会中止该 Vault 正在运行的语义请求。

### A. 能力发现、授权、分类和缓存

把下面这段直接发给 Agent：

> 验收批量语义分类。只用合成 DataFrame，不查询数据库。先调用
> load_skill，name 为 semantic-analysis，再通过 execute_python 使用
> await semantic.classify。构造 text 列两条内容：“football match”、
> “company earnings”；加一列 private，值为 PRIVATE_COLUMN_MUST_NOT_LEAVE，
> 但只选择 text 发送。标签 sports=体育新闻、business=商业新闻，明确要求
> 根据主题分类、不确定时保留 unresolved。保留分类对象并返回 rows 和 summary。
> 授权交给我确认。完成后以完全相同的输入、标签、instructions 再调用一次，
> 报告 cached 和新增请求数；不要用手写规则替代模型分类。

人工检查：

- trace 有 load_skill → execute_python → semantic 请求，而不是“无入口”。
- 授权显示接收端、模型、选定列和预算；等待时没有发送，拒绝时也没有发送。
- 确认后返回 rows/summary；未处理或失败不能被当成有效类别。
- 第二次 cached=2，没有新增推理请求；不是只读取已有变量冒充缓存调用。
- 设置的语义模型与 trace 实际请求模型一致，进度和用量可见。

### B. 抽取与实体匹配

加载同一 Skill，在 Python 中使用下面的合成数据；均需检查 summary 和原始行映射。

```python
receipts = pd.DataFrame({'text': ['Paid 12 dollars', 'Proposed payment of 12 dollars']})
extracted = await semantic.extract(
    receipts, columns=['text'],
    schema={'type': 'object', 'properties': {'paid': {'type': 'boolean'}},
            'required': ['paid'], 'additionalProperties': False},
    instructions='Determine whether an actual payment occurred. A proposal is not a payment.')
result = extracted.rows
```

第二行不得因为包含金额就被判定已支付；不确定应保留为 unresolved。

实体匹配使用 Skill 的 `semantic.resolve` 示例，构造名字相近但国家不同的实体。
核对 mapping 中 canonical_id 来自真实输入行，并保留未匹配、歧义和候选覆盖状态。
真实模型的输出不能强行指定 A=B/B=C/A≠C；这项确定性的非传递性约束由离线用例验收。

### C. 设置、预算与取消

- 在 AI 设置中选择已配置的独立语义模型，再恢复“跟随当前模型”，分别核对请求模型。
- 临时把记录预算设为 1，使用两个新输入测试，确认另一条为 unprocessed；
  继续同一 Agent run 不应获得新预算。测试后由用户恢复原配置。
- 等待授权时点击停止：无模型请求，无卡住的任务。
- 推理进行中点击停止：子请求取消、迟到结果不覆盖新任务，工作区显示丢失。
- 同样在推理进行中撤销授权，确认活动请求被中止，下一轮需要重新授权。

### D. 刷新与状态丢失

- 用来源 alias=t 查询 `SELECT 10 AS amount`，保存 `old_df = to_df('t')`。
- 同别名改成 `SELECT 30 AS amount`，核对新值 30、旧值 10、来源 version 更新。
  只重发相同 SQL 不足以验收刷新内容。
- 用独立测试会话验证停止运行导致状态丢失；或开启三个会话占满两 Worker，
  触发空闲工作区淘汰。下一次使用旧工作区必须明确收到 workspace_lost。
- 随后显式重建一个变量，核对新 generation、旧来源为空，没有自动重放旧查询。

记录人工验收时请注明版本、模型、会话/trace、授权是否预先存在、每项预期与实际、
结论是“通过 / 失败 / 未执行”。不要仅凭总结文本或 NameError 判定验收通过。
