---
connection_name: local-mysql
---

# Northstar Outfitters — Commerce Review Demo

Northstar’s June orders grew **25%** and net revenue grew **19%**, yet contribution margin fell from **42.2% to 16.8%**. This Vault is a complete investigation: connect the database, follow the SQL evidence, present the decision in Canvas, ask the Agent to verify it, inspect the real run in Agent Dashboard, and reuse the analysis through SQL templates.

Northstar 六月订单增长 **25%**、净收入增长 **19%**，但贡献利润率却从 **42.2% 跌至 16.8%**。这个 Vault 会带你走完整条分析链路：连接数据库、用 SQL 逐层定位问题、在 Canvas 汇总决策、让 Agent 复核并更新看板、在 Agent Dashboard 检查真实运行，再通过 SQL 模板复用分析。

## Choose a language / 选择语言

- [[en/01-business-context-and-metrics|Start in English →]]
- [[zh/01-业务背景与指标|从中文开始 →]]

## Live data in two minutes / 两分钟启动实时数据

The saved query results and Canvas work immediately. To rerun SQL, open a terminal in this Vault and run:

已保存的 SQL 结果和 Canvas 可以直接浏览。要重新执行查询，请在当前 Vault 目录运行：

```bash
docker compose up -d
```

Then open **Settings → Connections**, select `local-mysql`, and test it. The fixture uses the public local credentials `demo / demo`. **Try Demo Vault** saves that password into this device’s protected secret shard; when opening this source folder directly, enter `demo` once if prompted.

然后打开 **设置 → 数据库连接**，选择 `local-mysql` 并测试连接。示例数据库使用公开的本地凭据 `demo / demo`。通过 **Try Demo Vault** 创建时，密码会写入当前设备受保护的 secret shard；如果直接打开源码目录，首次使用时手动输入一次 `demo` 即可。

> Docker is optional for the guided story. AI configuration is only required for the final live Agent and Dashboard step.
>
> Docker 不是浏览完整故事的前提；只有最后的真实 Agent 与 Dashboard 步骤需要配置 AI。
