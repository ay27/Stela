---
type: stela-sql-template
name: Channel contribution / 渠道贡献利润
description: Compare channel revenue, spend, contribution profit, and margin for a reusable date range. / 按日期范围复用渠道利润分析。
connection_name: local-mysql
---

```runsql
WITH channel_orders AS (
  SELECT
    oe.order_month,
    oe.channel,
    COUNT(*) AS orders,
    SUM(oe.net_revenue) AS net_revenue,
    SUM(oe.profit_before_marketing) AS profit_before_marketing
  FROM order_economics oe
  WHERE oe.order_date >= '{{start_date}}'
    AND oe.order_date < '{{end_date}}'
    AND ('{{channel}}' = 'all' OR oe.channel = '{{channel}}')
  GROUP BY oe.order_month, oe.channel
)
SELECT
  co.channel,
  SUM(co.orders) AS orders,
  ROUND(SUM(co.net_revenue), 2) AS net_revenue,
  ROUND(SUM(co.profit_before_marketing - ms.spend), 2) AS contribution_profit,
  ROUND(
    SUM(co.profit_before_marketing - ms.spend) /
    NULLIF(SUM(co.net_revenue), 0),
    4
  ) AS contribution_margin
FROM channel_orders co
JOIN marketing_spend ms
  ON ms.month = co.order_month
 AND ms.channel = co.channel
GROUP BY co.channel
ORDER BY contribution_profit ASC
LIMIT {{limit}}
```
