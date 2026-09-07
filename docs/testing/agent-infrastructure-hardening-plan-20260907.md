# Agent 基础设施加固方案

日期：2026-09-07。状态：待评审的实施方案；本次仅编写文档，未实施。

## 1. 目标与非目标

目标：让同一个模型的有效工作不被超时、协议、状态遗失、输出截断与错误收尾破坏；让证据不足可见；让产品和 DAB 使用相同执行语义。

不承诺：仅靠基础设施提升新闻分类、CPC 粒度选择、脏 ID 解析等语义能力。执行成功、结果覆盖完整、业务判断正确是三个不同维度。

不做：重写 ReAct/Harness；增加通用 planner/reviewer 层；恢复计划完成度闸门；引入模型管理的 artifact、持久化 DataFrame 仓库或第二套数据执行链；自动召回大包业务上下文；扩大预算后直接宣称策略有效。

保留：现有 AgentHarness、有状态 Python、sources JSON、动态 query()、宿主语义授权与预算、局部缓存与 resume、已有结果审计和 Canvas 数据绑定。

交付目标是：可解释的失败、不会悄悄丢失的结果、有限且安全的恢复，以及可以复现实验的证据。准确率必须独立验收。

## 2. 当前证据与优先顺序

来源：[失败集诊断](../../.dab-results/stela-v0140-repair-failed-20260906-high/DIAGNOSIS.zh-CN.md)。该目录为本地结果，不是仓库分发依赖。

| 已观察问题 | 对应建设项 | 优先级 |
|---|---|---|
| 11 题被 180 秒 generation 总时限中断，空答案 | 分层超时、取消来源、共享收尾 | P0 |
| 部分流已生成但 usage 返回 0 | 使用量完整性与流活跃诊断 | P0 |
| 短暂 terminated 重试 4 次均成功恢复下一次生成 | 保留生成级恢复，禁止重放工具 | P0 |
| PATENTS/2 完整标题在最终回答中被省略 | 结构化答案保真 | P0 |
| usaspending/4 被判分器误抽取说明文本 | 原始判分与抽取争议分离 | P0 |
| 55 题未使用可选答案契约 | 默认事实检查，不依赖加载 skill | P1 |
| agnews/3 从全量改成样本，重复被拒 8 次 | 操作状态、已知覆盖与任务范围分离 | P1 |
| 5 次 reviewer 缺少 nextActions | 共享结构协议恢复规范 | P1 |
| 大量数据类型、变量、输入协议错误 | 现有工作区边界收敛与回归 | P1 |
| 金额数据与提示疑似不一致 | fixture/bridge/evaluator 一致性审计 | P1 |

实施顺序：先 P0 执行层，再 P0 交付层，再 P1 语义操作完整性。每批独立开关、独立验证，不再一次合并全部行为后跑一晚上。

## 3. 责任与状态边界

### 3.1 谁说了算

| 信息 | 权威位置 | 禁止事项 |
|---|---|---|
| 用户取消、授权、剩余预算、执行状态 | Main 服务 | 不由模型自报；取消不触发自动收尾推理 |
| 变量、DataFrame、语义批次、计算结果 | 现有 Python Worker 工作区 | 不复制到新的持久化仓库；丢失后不得静默重跑 |
| 来源版本、请求规格、实际返回计数 | 宿主审计 + Worker 实际观察 | 不能把 LIMIT/preview 的长度当全库总量 |
| 业务含义、粒度、排除规则 | 带来源的声明 | 模型声明不升级为机器验证事实 |
| 最终展示 | 现有结果 DTO + Renderer | 不让模型重新抄写/省略已经绑定的结果字段 |
| 官方 DAB 判分 | 原始 evaluator 输出 | 不因分析认为错判而覆盖 valid |

Shared 定义 DTO/Zod；Main 负责服务；Renderer 仅经类型化 preload 接口；Worker 复用既有 broker。计划仍是进度记录，不成为正确性权威。

### 3.2 两组状态，不能混成 success

- 执行状态：running / completed / failed / cancelled。
- 结果覆盖：complete / partial / unknown。指明覆盖的是查询结果、操作输入还是用户任务，不能跨层升级。

一个 Python cell 成功、处理了全部989条样本，依然不能证明14,860条总体任务完成。语义批次 schema 合法也不代表分类正确。UI 不展示“正确性已验证”这样的合并状态。

状态元数据复用现有 session/trace 与 workspace snapshot；压缩只影响叙述，不改变宿主状态。会话重开后工作区若丢失，历史元数据只能用于解释，不能作为仍然可执行的对象句柄。

## 4. P0-A：分层超时与安全恢复

主要位置：`electron/services/ai/generation-recovery.ts`、`agent.ts`、DAB runner；复用现有 SDK stream wrapper。

### 4.1 超时语义

拆分为：请求连接/响应头、首个有效 delta、流停滞、单次生成可选总上限、任务总体期限。

- 正常首轮不能共享一个名字叫 recovery 的固定180秒总时限。
- 总任务期限由调用方决定：DAB有显式总时限；桌面遵循现有取消/生命周期策略，不擅自套DAB的30分钟。
- high reasoning 请求的 thinking delta 也计为活跃，不仅统计可见文本；纯HTTP心跳不证明模型有进展。
- 收到有效delta重置停滞时钟；不重置任务总期限。源未暴露可靠delta时，明确降级为总时限模式。
- 重试最多3次，退避和新请求都不能超出剩余任务/恢复预算。重试生成，不重试整个任务；失败生成中的工具参数永不派发。
- 首token/停滞阈值先通过记录和可配置策略校准，不再凭经验写死一个新数字。第一步先解除不合理180秒上限，保留调用方任务期限与用户取消，再用shadow计时决定是否强制停滞中断。

诊断增加：attemptId、generationId、stopCause、firstDeltaMs、lastDeltaMs、最大delta间隔、delta数量/字节、响应状态、尝试次数、剩余任务时间。记录计数，不记录额外原始思考内容或凭证。

### 4.2 取消与收尾

区分 user_cancel、task_deadline、generation_stall、generation_deadline、provider_transient、provider_refusal、auth、budget、workspace_lost。

- 用户取消：立即停止，零新增推理/查询，UI显示取消与现有进度。
- 安全拒绝、鉴权、额度错误：不自动重试，不换模型绕过；宿主生成明确状态说明。
- 恢复次数耗尽/任务期限将到：若有已经提交的结果且预算允许，最多一次 tool-less 收尾；否则由宿主展示已有结果和未完成原因。
- 收尾只可引用已提交证据；无数据库工具、无semantic发送、无新问题求解。它不是再次启动任务。
- 原始失败原因始终保留，不能因为收尾产生了文字就清空 error。分别记 executionFailure、deliveryStatus、salvageOutcome。
- 桌面与DAB共享同一收尾决策函数；DAB只注入期限与评测适配，不另造成功逻辑。

验收：模拟持续delta超过180秒仍正常完成；停滞被正确识别；重试后已执行工具次数不变；取消期间/退避期间没有新请求；主失败+收尾失败均可观测。使用假时钟和真实SDK本地HTTP流两层测试。

### 4.3 用量

usage 增加 complete / partial / unknown 标记；已收到delta但未返回usage，不记为“零成本”。已知usage只累加一次；不估算为实际账单；主模型和semantic预算账本分栏，禁止重复相加。

## 5. P0-B：从计算结果到最终交付不丢信息

主要位置：`agent-tools.ts`、`python-runtime-core.ts`、Shared result DTO、Agent Panel、DAB answer adapter。

### 5.1 复用结果链，不新增 artifact 系统

建议在现有 `execute_python` 同一次调用中增加可选的类型化输出声明，例如：

```json
{
  "code": "final_df = ...",
  "output": {
    "useAs": "answer",
    "variable": "final_df",
    "columns": ["cpc_group", "titleFull", "best_year"]
  }
}
```

这只是建议的新增接口，不是现有语法。Worker在代码成功后通过变量表取值，不eval变量名；校验变量和列真实存在，然后沿现有结果响应返回。保留旧 `result` 写法向后兼容。

- 同一工具调用可完成计算+结果选择，不要求额外 publish tool 往返。
- 复用已有同run结果注册机制；不新增供模型传递的artifact路径/runId输入协议。
- run_query 的小完整结果也支持同等绑定；截断preview不能用作精确整表交付。
- 不默认把“最近一个result”当答案，避免调试表覆盖最终结果。声明answer用途才更新候选；后续失败不自动删除先前候选，但必须提示它可能不是本次最终完成结果。
- Worker重置后，只能展示已经通过现有结果响应提交的有界快照；未提交的大对象不可凭历史句柄重建。

### 5.2 保真展示

最终由两部分组成：模型说明 + 宿主绑定的结构化值/表。字段值不经第二次模型复述；数值精度、完整字符串、列顺序保留。

大结果仍留在既有工作区/既有结果展示链中，以有界预览展示并显式标注完整性。对“必须完整交付的大表”，若当前路径不能满足，则标为未完成或经用户授权导出；不静默截断，也不为此搭建新文件系统。

没有绑定结果的纯解释/代码建议照常回答；涉及数据答案但无法绑定时记为unverified，不一律禁答。

### 5.3 防止变成新的死循环

默认宿主检查：绑定对象是否存在、字段是否齐全、结果是否明确截断、已知partial操作是否被当成完整结果。

- 首阶段仅shadow记录，不改变回答。
- 严格模式只拦已知结构矛盾；最多一次有预算的交付修正机会，不重新开放数据探索。
- 修正仍失败则输出明确partial/unverified状态，而不是反复“请完善契约”。
- 不做“所有计划步骤完成”“模型说验证过了”之类无事实依据的通过条件。

验收：完整CPC标题往返字符不丢失；精确decimal/空值/列顺序保持；正文含相似词不能改变绑定答案；调试表不替换答案；错误输出声明有可定位错误；无声明的普通问答不回归。

### 5.4 DAB评分适配边界

保留旧的完整回答和官方valid。另存 answerPayload、explanation、scoreInput、adapterVersion；如改为仅把精确结果送evaluator，必须设为新评测模式并重新建立baseline，不能和旧分数混报。

本轮usaspending/4错判以独立诊断记录；不能通过偷偷改抽取器或改输入追求涨分。PATENTS/2的完整字段交付则是产品本身应修的问题。

## 6. P1-A：语义操作状态、预算与覆盖

主要位置：`semantic-execution.ts`、`python-semantic-runtime.ts`、`python-runtime-broker.ts`、Shared semantic DTO。

### 6.1 宿主维护有界操作状态

复用现有input/definition/model签名与resume批次，不增加单独服务或持久化任务队列。

每个操作记录：输入身份、来源版本（能获取时）、总输入数、成功/未决/失败/未调度数、缓存/续用数、已耗与在途预留预算、停止原因。业务行状态与请求尝试计数分开；重试不增加“独立已处理行数”。

预算状态修改时才推进 budgetRevision。当前每次preflight都增加revision，不适合用来判断预算是否改变；另记eventSequence用于观测。

对于相同输入/定义/预算/授权状态的确定拒绝，直接返回同一个有界拒绝结果，零额外推理；连续重复时给剩余可行动项，而不是屏蔽整个execute_python。下一次预算、输入或授权真正变化后才重新检查。

### 6.2 并发预算

宿主按每个in-flight batch原子预留record/request/token上限，结算后释放可确定的余量。已支持的预留逻辑优先复用并补race测试，不重写账本。

preflight只是必要条件，不是全操作可完成承诺，不能命名/展示为“已保证全量”。不做未知token成本的假精确全量预留；无可靠usage时采用保守记账并标明口径。取消后停止调度，已在途请求的结果/用量仍需结算，不能取消即把成本清零。

### 6.3 操作覆盖与总体覆盖分别记录

- 宿主自动知道：传入多少条、处理多少条、来源是否preview、是否预算停止。
- 模型可声明：这些输入对应哪个问题总体、为什么过滤、是否抽样、是否允许估计；声明带原始用户约束/来源引用。
- 任意pandas过滤/聚合/复制的完整血缘不可能靠简单元数据自动追踪；本期不构造伪完整的DataFrame污点追踪系统。无法确认的关联标unknown。
- 对已知partial的语义结果，即使变成普通DataFrame，也不能凭模型自报升级为validated-complete；如没有可验证关联，只能降低验证等级。
- 已明确绑定的14,860条总体不能因为后来传989条而覆盖成989条。允许生成一个子集操作，但保留父总体缺口；扩大预算和允许估计必须有真正的用户授权，ask_user无人回答不等于授权。
- 不可从未知总体推出complete；也不能机械要求所有原始行都进入最终答案，合法筛选应有排除理由和对应计算阶段。

`analysis.contract` 保留为高级辅助，但默认检查不依赖其被调用；它也不能自己授予结果完整性。

验收：14,860→989的已声明子集不能变为精确全量；无已知血缘则unknown而非虚假通过；重复拒绝零发送；同名来源刷新使resume身份失效；成功行续算不重复发送；并发批次预算不超；各行终态互斥且与total守恒，cached/reused为辅助计数不能重复相加。

## 7. P1-B：工作区与工具错误边界

不改变已验证的sources语义：省略复用、重声明刷新alias、旧DataFrame仍是旧快照。重点是减少误解和恢复成本。

- 每次工具返回紧凑workspace generation、实际刷新alias、可用变量类型、来源版本、结果完整性；不默认dump全部变量值。
- NameError给可用变量名；alias错误给alias列表和to_df用法；DuckDB relation与DataFrame边界明确；不自动把alias变为同名全局变量制造歧义。
- 普通Python异常保留partial_mutation_possible：不宣称事务回滚。reset/崩溃/驱逐才标lost，并使旧执行句柄失效。
- 输入source字段在执行任何source前整体验证；SQL/Mongo错位给明确字段修正，不把权限错误包装为语法错误。
- 每个entity维度保留截断标记；schema列覆盖与字符串精度分开；不恢复SELECT *猜测。
- 大查询继续sources→Python，现有内部传输实现不升级为模型可见artifact。

## 8. P1-C：结构化协议恢复与复盘器

共享一个小型结构响应解析辅助函数：允许剥离完整JSON围栏，随后做目标schema校验；禁止从任意说明文本里猜JSON、禁止执行返回内容。不同功能保留各自schema，不做万能宽松parser。

- reviewer的nextActions缺失：最多一次工具禁用的修复请求，传缺失字段及有界原响应，计入预算；仍错则标review_unavailable并继续主流程。
- terminal拒绝/取消不修复重试。review失败不升级为整个agent失败。
- semantic现有逐行修复不变；共享的是解析规范，不统一成一套会重复重试的嵌套循环。
- 观测review是否改变下一步行动，不以调用次数衡量效果。

## 9. 可观测性与评测可信度

原始错误与归因分离：provider、generation timeout、tool input、execution、workspace、coverage、delivery、evaluator八类轴；保留多因信息，不全部归为路由错误。

每题报告保留：执行终止原因、交付状态、覆盖事实、官方valid、判分争议、模型/策略/source/adapter指纹、已知usage与未知usage计数。

补fixture生成代码版本、可安全获得的fixture身份/只读校验摘要、bridge版本与evaluator版本。不能只看主仓库指纹就假定数据库内容没变；完整数据库hash过贵时说明校验边界，不假装证明一致。

usaspending先抽取少量固定记录做只读原始fixture→bridge返回→reference evaluator三方核对，敏感内容留本地且脱敏；不是把ground truth提供给agent。确认数据与提示一致性后再评价金额语义策略。

HTML分析继续中文；官方成绩、失败集恢复、历史拼接、抽取修正后的诊断成绩分开，不能混成一条曲线。

## 10. 实施拆分与验证闸口

| 批次 | 范围 | 通过条件 | 不通过时 |
|---|---|---|---|
| 0 | 固化本轮55题结果、构造最小脱敏协议/超时fixture | 离线能复现关键失败；原结果只读 | 不开始行为改造 |
| 1 | 超时、取消、恢复诊断、共享收尾 | 长流/停滞/取消/工具不重放全通过；桌面+DAB一致 | 只回退新超时策略，保留已验证短故障重试 |
| 2 | 结果绑定、保真展示、DAB并行诊断 | 字段无损；不选错结果；普通问答无回归 | 关闭结构交付开关，不改官方判分 |
| 3 | 操作状态、预算revision、coverage shadow | 计数守恒；并发不超预算；unknown不冒充complete | 保持观察，不启用拦截 |
| 4 | 已知矛盾的有界交付检查、review协议修复 | 无重复检查死循环；取消不新请求；最大一次修正 | 回到shadow |
| 5 | 小型真实对照及桌面冒烟 | 核心确定性缺陷消失；旧成功哨兵未出现可归因回归 | 定位单一批次，不继续全量 |
| 6 | 同条件全量验证 | 同时报告正确率、故障率、覆盖、成本、分布 | 不用失败集拼接宣称完成 |

建议首轮真实对照最多12题×2个配置，各1次（24个case-run，上限预算执行前确认）。覆盖CVE长生成、agnews/2/3、PATENTS/2/3、usaspending/4及旧成功哨兵；从冻结trace选定名单后不按结果换题。

长流与API缺陷先靠离线重放验收，付费测试只验证真实模型/链路行为。12题不是显著性证明：对有波动的关键题再做预先约定的重复；未经用户同意不自行跑全天全量。

建议指标：空答案/原因、误杀活跃流次数、重复工具副作用数、重复semantic发送数、未知用量占比、交付字段损失、已知partial冒充complete、模型往返、中位/P90耗时、官方valid及判分争议。

确定性安全与保真用例要求100%通过。准确率不设没有依据的“必涨X%”；候选必须先证明没有可归因的旧成功回归。少量样本的“未观察到下降”不能宣称统计非劣。

## 11. 文件责任与架构文档

- generation-recovery.ts及测试：分层计时/诊断；不改模型核心能力。
- agent.ts与run-data-agent-bench.ts：共享生命周期/收尾决策接入；两端相同事实语义，DAB期限独立注入。
- semantic-execution.ts、python-semantic-runtime.ts及broker：操作状态、预算、resume与覆盖；不新建持久化执行系统。
- python-runtime-core.ts、agent-tools.ts、Shared DTO：输出声明与结果保真；沿既有执行结果链路。
- Agent Panel/preload/IPC schema：只增加必须展示的类型化状态，遵守三进程边界。
- analysis-efficiency相关模块：reviewer结构修复及可观测性，不新加reviewer。
- scripts/eval：manifest、配对评测与诊断报告；不改官方验证器提升成绩。

实施前需按create-adr项目skill形成决策：

1. 澄清/如有必要supersede ADR-0092的deadline与共享收尾边界；保留ADR-0094正式提交与预览分离原则。
2. 新增结构化结果交付与可核验状态决策；若将默认检查从可选契约迁出，明确supersede ADR-0093相应决策，不能暗改active正文。
3. 如新增宿主操作状态/预算版本契约，评估是否需supersede ADR-0091；现有计划无答案权威原则保持不变，不恢复旧finalize_analysis闸门。

本方案不预占ADR编号、不修改active正文。代码实施同批更新ARCHITECTURE.md、ABSTRACTIONS.md和ADR索引；新语义只在实现后写入“当前架构”，避免计划冒充现状。

## 12. 首次实施的明确范围

只执行批次0和1：复现、分层计时、取消、重试不重放、共享安全收尾、用量完整性。完成离线与桌面验证后，再申请小规模真实验证。

不在第一批顺手调prompt、换模型、加语义预算、改分类规则或评分器。先拿到“相同任务不会被我们自己的基础设施错误破坏”的证据，再推进交付与覆盖。
