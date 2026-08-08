---
type: stela-data-note
connection_name: local-mysql
created_at: "2026-07-08T02:00:00.000Z"
---

# 1. Business context and metric definitions

You are preparing Northstar Outfitters’ June operating review. The headline looks excellent: more orders and more net revenue. Finance is concerned because the cash contribution from that growth collapsed.

## The question

**Where did June’s growth come from, why did it produce less profit, and what should the team change before the July campaign?**

## The business model

Northstar is a fictional direct-to-consumer outdoor brand. The demo contains 600 customers, 24 products, 1,650 orders, 2,930 order lines, returns, and monthly channel spend across January–June 2026.

The live MySQL fixture exposes these tables:

- `customers`, `products`, `orders`, and `order_items`
- `returns` with refunds and processing cost
- `marketing_spend` by month and channel
- `order_economics`, a readable order-level view used throughout the review

## The metric that matters

```text
Net revenue = gross sales - discounts - refunds
Contribution profit = net revenue - product cost - fulfillment cost
                      - return processing cost - marketing spend
Contribution margin = contribution profit / net revenue
```

This is a growth-quality review, not a top-line sales report. Fixed payroll and overhead are deliberately outside the metric.

Continue to [[en/02-growth-quality-investigation|2. Growth quality investigation →]].
