---
type: stela-sql-template
name: High-return SKU / 高退货商品
description: Rank return rate and return loss by SKU with reusable category and volume filters. / 按品类和销量门槛复用退货风险分析。
connection_name: local-mysql
---

```runsql
SELECT
  p.sku,
  p.name,
  p.category,
  SUM(oi.quantity) AS sold_units,
  COALESCE(SUM(r.quantity), 0) AS returned_units,
  ROUND(COALESCE(SUM(r.quantity), 0) / NULLIF(SUM(oi.quantity), 0), 4) AS return_rate,
  ROUND(COALESCE(SUM(r.refund_amount + r.processing_cost), 0), 2) AS return_loss
FROM order_items oi
JOIN orders o ON o.id = oi.order_id
JOIN products p ON p.id = oi.product_id
LEFT JOIN returns r ON r.order_item_id = oi.id
WHERE o.order_date >= '{{start_date}}'
  AND o.order_date < '{{end_date}}'
  AND ('{{category}}' = 'all' OR p.category = '{{category}}')
GROUP BY p.id, p.sku, p.name, p.category
HAVING sold_units >= {{minimum_units}}
ORDER BY return_rate DESC, return_loss DESC
LIMIT {{limit}}
```
