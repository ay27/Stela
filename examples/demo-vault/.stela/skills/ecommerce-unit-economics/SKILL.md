---
name: ecommerce-unit-economics
description: Verify Northstar ecommerce growth quality with contribution margin, channel, promotion, and return evidence.
category: metric-definition
tags: [ecommerce, contribution-margin, channel, promotion, returns, mysql]
source_tables: ["order_economics", "marketing_spend", "order_items", "products", "returns"]
---

# Ecommerce unit economics / 电商单位经济性

## Scope

Use this Skill for Northstar growth-quality questions involving revenue, contribution profit, channel spend, promotions, or returns. Use `local-mysql` and live schema truth when available.

## Definition

- Net revenue = gross sales - discounts - refunds.
- Contribution profit = net revenue - product cost - fulfillment cost - return processing cost - marketing spend.
- Contribution margin = contribution profit / net revenue.
- 净收入 = 商品原价收入 - 折扣 - 退款。
- 贡献利润 = 净收入 - 商品成本 - 履约成本 - 退货处理成本 - 营销花费。

## Grain & Filters

`order_economics` has one row per order and already includes item, refund, fulfillment, and pre-marketing economics. Join `marketing_spend` only after aggregating or on a matching month/channel grain; never multiply monthly spend by the number of orders. For SKU return analysis, use `order_items` as the grain and join `returns` by `order_item_id`.

## Verify

Before making a recommendation, verify the monthly break, isolate channel contribution after spend, compare promoted with non-promoted orders, and check whether a high-volume SKU has abnormal return loss. Bind Canvas sources only to successful table-backed `run_sql` results.
