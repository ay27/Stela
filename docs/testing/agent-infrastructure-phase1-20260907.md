# Agent 基础设施第一批实施与验收

日期：2026-09-07。
范围：[加固方案](./agent-infrastructure-hardening-plan-20260907.md) 的第一批执行生命周期，未实施结构化答案绑定、覆盖闸门或语义策略升级。

## 已实施

1. 移除正常生成默认180秒总时限。响应、首delta、停滞、总时限均可分别配置，尚未校准的阈值默认关闭；DAB原有任务期限和桌面取消仍生效。
2. 保留最多3次生成级尝试；180秒恢复窗口从首次可重试故障后开始。已提交工具与失败流中的工具均不重放。
3. 记录generationId、首次/最后delta、最大间隔、delta数量/字节、终止原因、调用方取消原因、请求是否实际启动，以及usage完整性。thinking和tool-argument delta算活跃；空delta不算。
4. 真实SDK对非2xx响应不触发onResponse：识别其规范化的开头HTTP状态前缀，并标记statusSource=sdk_error_prefix。不是从任意报错中猜数字。
5. 桌面与DAB共用closeoutGeneration：必须有已提交查询/Python证据、可恢复失败及剩余时间；最多一次、最多120秒、无工具、无SDK/外层重试。
6. 用户取消、拒绝、鉴权、额度错误不发起收尾；收尾进行中取消也不再发请求。
7. 桌面error事件可附partialAnswer，历史持久化和Panel回放均保留它；终态仍是error，不运行成功后的Skill维护。
8. DAB保留原始error/executionFailure，另外记录closeout和generationUsage。执行失败与可交付部分答案不再混为成功；官方valid与评分输入规则不变。
9. DAB executionPolicy升级为semantic-operation-v1-generation-lifecycle-v2-answer-contract-v1，不能复用旧条件输出目录混跑。

代码集中在generation-recovery.ts、generation-closeout.ts、agent.ts、DAB runner、AgentEvent及历史/Panel错误展示路径。复用已有工作区、结果审计、SDK和工具接口；未新增依赖、artifact、数据执行链或模型。

## 通过的检查

```bash
npm test
npm run test:semantic
npm run test:semantic-workflow
npx tsx scripts/eval/data-agent-bench/runner.integration.test.ts
npm run build
npm run check:release
git diff --check
```

关键验收证据：

- 假时钟推进240秒、持续thinking delta：正常完成，不再被180秒误杀。
- 分别测试响应/首delta/总期限；思考和工具参数可重置idle，空delta不能；触发后即使测试provider忽略signal，外层也有界返回且不提交迟到内容。
- 首次正常生成耗时240秒后才失败：恢复窗口从故障后开始，而不是从任务开始计算。
- 真实AgentHarness：先完成工具，再断流重试，工具执行计数始终为1；失败流工具不派发。
- 真实SDK+本地HTTP：连续三次503后恰好一次收尾；run_query只执行1次，executionFailure仍保留。
- 无查询证据的tool cap：不再强制“尽力回答”；有查询证据的tool cap：允许收尾但保留tool_call_cap错误。
- 用户预先取消、退避期间取消、流期间取消、收尾期间取消：不启动替代推理。
- partial usage保留；缺失usage标unknown，不计作已确认零成本；未实际启动的请求不增加未知用量请求计数。
- Main历史写入/读取保留error+partialAnswer；Renderer历史回放同时展示部分结果和原始错误；旧格式错误兼容。
- 既有真实Pyodide/broker/语义授权工作流回归通过。

这些是离线/本地HTTP与状态回放测试，不是新的付费DAB准确率结果，也不是桌面真实模型端到端测试。

## 额外类型检查限制

`npx tsc -p tsconfig.node.json --noEmit` **尚不通过**，该独立Main检查包含仓库已有的agent-history旧类型、AgentPlanSnapshot旧测试字段、connector与其他模块类型错误。新增generation-recovery/closeout/lifecycle模块及本次agent.ts接入区段的类型错误已清理；未顺手重构无关模块。

项目标准`npm run build`通过，但其中`tsc --noEmit`使用的是Renderer tsconfig，不能把它等同于Main全量严格类型检查通过。两项结果分别记录。

## 待做的真实验证

1. 桌面用普通提问检查流式预览；进行中取消后确认没有后续请求。故障场景优先使用独立测试profile/本地provider，不修改用户现有配置。
2. 固定小批DAB案例与旧成功哨兵、同模型同预算做对照，重点看180秒误杀、空答案、重复工具与收尾结果。不据此先承诺准确率提升。
3. 观察first/last delta与gap分布后，再决定是否启用默认首响应或停滞阈值；不能立即换成另一个武断上限。

本次没有同步远端、启动付费测试、修改评分器或修改旧DAB结果；也没有提交Git。

ADRs：新增0095，supersede0092；保留0094预览隔离规则。Docs：ARCHITECTURE.md、ABSTRACTIONS.md、ADR索引与本文。
