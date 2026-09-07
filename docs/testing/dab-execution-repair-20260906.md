# DAB 执行链路修复验收（2026-09-06）

## 本次范围

保留有状态 Python 工作区，不引入模型管理的 artifact 或新依赖。
实现 JSON 围栏本地恢复、逐行修复、生成级有限恢复、全量意图 preflight、
预算熔断、输入/结果契约、绑定原始输入与模型的续算，以及本地答案契约。
新增 ADR-0091、0092、0093、0094；不修改已有 active ADR 正文。

## 确定性回归

```bash
npm run test:semantic
npm run test:semantic-workflow
npm run test:python-workspace
npm run eval:semantic-boundaries
npm test
npm run build
```

- 合法围栏 JSON：一次推理成功；不从任意文本中截取或执行 JSON。
- 一行不合法：保留其他成功行，只重试缺失/错误行；ID/证据/schema 检查保留。
- 真实 Harness：工具完成后发生断流，不重放已执行工具，也不执行失败响应中的工具。
- UI 预览和正式上下文分离：预览可更新/撤回，失败内容不写入模型历史。
- 重试有次数与期限；敏感内容、鉴权、额度、取消不走通用重试。
- 默认全量任务超过记录预算：一条 preflight RPC、零模型请求，返回未处理状态。
- 1000 行任务预算耗尽：最多调度已在途的一组，不遍历全部剩余批次。
- 跨 cell/run 续算：原输入/定义/模型保持一致，只处理缺失行；更换顺序/模型拒绝混用。
- `.rows` 保留 DataFrame；`.to_records()` 可按字典迭代；`require_complete()` 拒绝部分结果。
- 指令需要 header 但未选 header：通过 required_fields 在发送前拒绝。
- 稳定业务行 ID 可用，重复 ID 拒绝；超长记录显式失败，不截断传给模型。
- 答案契约可跨 cell 保留；细分代码冒充更高层级、覆盖不足、冲突口径均可显式标出。

服务集成使用真实 Pyodide、工具、主进程 broker 和 SDK 序列化，HTTP/授权使用离线
替身；不代表真实提供方连接、真实语义判断或桌面 UI 已完成端到端验收。
新增边界集有 11 个**合成**样本，区分 dev/test，默认只检查格式且不调用模型。
真实分类/抽取/归并准确率需显式运行模型并扩充真实业务标注保留集。

## 桌面手工复核

1. 普通提问确认仍有流式文字预览；生成完成才持久化。取消后不得继续发送请求。
2. 加载 semantic-analysis，使用两行合成 DataFrame 分类，检查 `.summary`、
   `.to_records()`、第二次缓存命中及授权撤销；不要用真实敏感数据做冒烟。
3. 用 required_fields 声明未选中的 header，确认提示缺失且没有语义发送。
4. 加载 analysis-verification，用实际来源声明 population/granularity，检查
   `report()` 的未知项与失败检查，不为凑 structurallyReady 反复查询。

## 评测与限制

使用新的 DAB output。源码指纹、执行策略和模型/端点/推理/并发/限制加入 manifest；
旧目录或不同条件不能 resume 混跑。比较同一代码下的 stateful-only 和 stateful+semantic，保持主模型、
推理等级、并发、预算相同；先配对小集并带稳定通过控制组，再全量重复测试。
单轮分数变化不能归因于某个功能；失败子集不能拼成正式全量成绩。

Preflight 是保守可行性检查，不预留整项预算，也不能保证未知 token 成本。
大规模历史缓存只探测前八条；保留原 batch 并 resume 可避免重新探测全量。
allow_partial 不是抽样，不能以有偏的处理头部外推精确总量。
答案契约检查输入声明和观察值，不证明声明本身正确；不新增强制 final gate。
本次没有远程同步、真实模型边界测评或新一轮 DAB，准确率收益仍待验证。
