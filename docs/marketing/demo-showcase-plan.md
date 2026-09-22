# Demo Vault 截图操作说明

## 开始前

1. 打开 Stela，打开 Vault：`/Users/jinmianye/personal/stela-opensource/examples/demo-vault`。
2. 在设置中测试 `local-mysql`，看到“连接成功”。AI 选择一个可用模型。
3. 先拍中文，再拍英文。每张截图保存名称见各步末尾。

## 中文截图

将应用界面语言和 AI 回复语言设为中文。

### 1. SQL in Markdown

1. 打开 `zh/02-增长质量诊断.md`，收起右侧 Agent 面板。
2. 找到“2 — 找出买来亏损增长的渠道”，点击这一段 SQL 的 **Run**。
3. **等到执行成功、出现 5 行渠道结果**，让小标题、SQL 和结果表同时出现在画面里，截图：`zh-markdown.png`。

### 2. SQL in Chat

1. 按 **⌘⇧N** 新建 SQL 对话，选择 `local-mysql`。
2. 粘贴下面的全部内容，按 **⌘Enter** 发送（`net_revene` 是故意写错的）：

```text
SELECT channel, ROUND(SUM(net_revene), 2) AS revenue
FROM order_economics
WHERE order_month = '2026-06'
GROUP BY channel;

帮我修正这条 SQL，比较六月各渠道净收入，直接在当前对话里画柱状图。
用中文回复，简单指出修正了哪里即可，图表标题也用中文。
```

3. **等到 SQL 修正并执行成功、对话里出现柱状图**，收起长的执行详情，让你的消息、简短回复和图表同屏，截图：`zh-chat.png`。
4. 如果只回复文字，继续发送：`请直接在当前对话中展示柱状图，不要只描述图表。` 等图出现后再截。

### 3. Stela Agent

1. 打开 `zh/经营复盘.stela.canvas`，展开右侧 Agent 面板，新建一个会话，选择 `local-mysql`。
2. 发送：

```text
结合中文历史笔记、ecommerce-unit-economics 知识和 local-mysql，复核六月各渠道的贡献利润。
执行 SQL 验证，营销花费按月份、渠道只扣一次。
用中文、三句话以内说明最值得关注的渠道及数据依据，不新建 Canvas。
```

3. **等到查询成功并输出结论**，左侧显示报表，右侧显示工具记录和结论，截图：`zh-agent.png`。

### 4. Canvas 数据血缘

1. 留在刚才的 Agent 会话，发送：

```text
请用 2026 年 6 月的实际数据，画清贡献利润是怎样一步步算出来的。
更新现有贡献利润血缘 Canvas；若尚未创建，在 zh 下创建，标题设为“贡献利润数据血缘”。使用原生 flow 卡片，中文标注。
主链路：商品销售额 → 扣折扣、退款 → 净收入 → 扣商品成本、履约费、退货处理费 → 营销前利润 → 扣营销花费 → 贡献利润及贡献利润率。
每个金额节点显示本次查询验证的 USD 数值和简短来源；在对应汇总步骤标出订单数、商品明细行数和渠道数，区分这些粒度。营销花费按月份×渠道只扣一次。
图里用业务名称、金额、数量和“汇总 / 扣除”等短标签；SQL、JOIN 条件和字段公式放在图下的简短口径说明中。
采用紧凑的从上到下布局。将成功查询绑定为数据源，核对金额勾稽、保存并重读，返回实际保存路径。
```

2. **等到数值查询成功、保存完成**，打开回复中给出的实际 Canvas 路径。
3. 收起 Agent 面板，把流程图缩放到完整可见、节点文字可读，截图：`zh-canvas-lineage.png`。
4. 截图前确认节点内有六月实际金额和数量，且扣减合计等于最终利润；只有表名或 JOIN 条件的图不要截。

### 5. 首屏总览与报表

1. 打开 `zh/经营复盘.stela.canvas`，展开 Agent 面板，发送：

```text
把刚才验证的六月渠道分析更新到当前经营复盘 Canvas。
保留其他区块，更新渠道贡献图、查询结果和三条简短中文结论，关联本次成功执行的 SQL。
不要新建第二份报表，保存后重新读取检查。
```

2. **等到保存完成，报表中的图表正常显示**，滚动到能同时看到趋势图、渠道图和结果表的位置。
3. 收起 Agent 面板，截图：`zh-canvas-report.png`。
4. 展开 Agent 面板，让报表和分析结论同屏，截图：`zh-workspace.png`。

### 6. 笔记与知识

1. 在刚才的 Agent 会话发送：

```text
确认本次口径：贡献利润扣除退款、商品成本、履约费、退货处理费和渠道营销花费。
营销花费按月份及渠道扣一次，不能随订单连接重复累加。
请把这次确认用中文记录到 zh/03-管理行动方案.md，供后续渠道复盘参考。
```

2. **等到笔记保存**，展开回复末尾的知识维护状态，查看实际结果；跳过不代表生成了知识。
3. 点击底部“知识”，找到相关 Skill，点击“查看正文”。
4. 让知识正文、指标口径和来源说明可见，截图：`zh-knowledge.png`。
5. 如果没有新增知识，展开已有 `ecommerce-unit-economics` 的正文截图，并标记“预置知识”。没有来源笔记时保留真实提示，不把它当作自动维护的结果。

### 7. 数据库插件

1. 打开 **设置 → Plugins**，选中 MySQL 插件。
2. **看到插件已加载及详情**时截图：`zh-plugins.png`。

## 英文截图

将应用界面语言和 AI 回复语言设为 English。下面都用新的英文会话。

### 1. SQL in Markdown

1. 打开 `en/02-growth-quality-investigation.md`，收起 Agent 面板。
2. 找到按渠道分析的 SQL（包含 `SELECT oe.channel`），点击 **Run**。
3. **等到出现 5 行结果**，让小标题、SQL 和结果表同屏，截图：`en-markdown.png`。

### 2. SQL in Chat

1. 按 **⌘⇧N** 新建 SQL 对话，选择 `local-mysql`。
2. 粘贴并发送：

```text
SELECT channel, ROUND(SUM(net_revene), 2) AS revenue
FROM order_economics
WHERE order_month = '2026-06'
GROUP BY channel;

Fix this query and compare June net revenue across channels.
Show a bar chart directly in this conversation.
Reply in English, briefly explain the correction, and use English chart labels.
```

3. **等到修正后的 SQL 执行成功、柱状图出现**，让输入、简短回复和图表同屏，截图：`en-chat.png`。
4. 如果只回复文字，发送：`Please display the bar chart directly in this conversation.` 等图出现后再截。

### 3. Stela Agent

1. 打开 `en/business-review.stela.canvas`，展开右侧 Agent，新建会话，选择 `local-mysql`。
2. 发送：

```text
Review June contribution profit by channel using the English notes, the ecommerce-unit-economics Skill, and local-mysql.
Verify the figures with SQL. Deduct marketing spend once per month and channel.
In no more than three sentences, identify the channel that needs the most attention and cite the supporting figures.
Reply in English. Do not create another Canvas.
```

3. **等到查询成功并输出结论**，左侧显示报表，右侧显示工具记录和结论，截图：`en-agent.png`。

### 4. Canvas 数据血缘

1. 在刚才的 Agent 会话发送：

```text
Show how contribution profit is calculated using actual June 2026 data.
Update the existing contribution-profit lineage Canvas. If none exists, create one under en with the title contribution-profit-lineage. Use a native flow card with English labels.
Trace gross sales → deduct discounts and refunds → net revenue → deduct product costs, fulfillment and return processing → profit before marketing → deduct marketing spend → contribution profit and margin.
Show the verified USD amount and a short source label at each monetary step. Include order counts, item-row counts and channel counts at the relevant aggregation steps, keeping their grains distinct. Deduct marketing spend once per month and channel.
Use business labels, amounts, counts and short arrows such as “aggregate” or “deduct” in the diagram. Put SQL, join conditions and field formulas in a brief methodology note below it.
Use a compact top-to-bottom layout. Bind successful queries as data sources, reconcile the amounts, save and read back the Canvas, and return its actual saved path.
```

2. **等到数值查询成功、保存完成**，打开回复中给出的实际 Canvas 路径，收起 Agent。
3. 让流程图完整可见、文字可读，截图：`en-canvas-lineage.png`。截图前确认节点内有六月实际金额和数量；只有表名或 JOIN 条件的图不要截。

### 5. 首屏总览与报表

1. 打开 `en/business-review.stela.canvas`，在 Agent 中发送：

```text
Update the current business-review Canvas with the June channel analysis you just verified.
Preserve the other sections. Update the channel contribution chart, query results, and three brief findings in English, using successful SQL runs from this analysis.
Do not create a duplicate report. Save and read back the Canvas to check it.
```

2. **等到保存完成、图表正常显示**，滚动到趋势图、渠道图和结果表可见的位置。
3. 收起 Agent，截图：`en-canvas-report.png`。
4. 展开 Agent，让报表和英文结论同屏，截图：`en-workspace.png`。

### 6. 笔记与知识

1. 在 Agent 中发送：

```text
Confirmed definition: contribution profit deducts refunds, product cost, fulfillment cost, return processing cost, and channel marketing spend.
Deduct marketing spend once per month and channel, never once per joined order.
Record this confirmation in English in en/03-management-action-plan.md for future channel reviews.
```

2. **等到笔记保存**，展开知识维护状态，查看实际结果。
3. 点击底部知识入口，找到相关 Skill，点击“View content”。
4. 让英文知识正文、指标口径和来源说明可见，截图：`en-knowledge.png`。
5. 如果没有新增知识，展开已有 Skill 的英文正文截图，标记“Preloaded knowledge”；不要当作本轮自动维护结果。

### 7. 数据库插件

1. 打开 **Settings → Plugins**，选中 MySQL 插件。
2. **看到插件已加载及详情**时截图：`en-plugins.png`。
