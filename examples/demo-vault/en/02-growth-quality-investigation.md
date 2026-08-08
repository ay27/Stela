---
type: stela-data-note
connection_name: local-mysql
created_at: "2026-07-08T02:00:00.000Z"
---

# 2. Growth quality investigation

The saved results below make this review readable without Docker. With `local-mysql` running, execute each block again to produce your own audited run.

## 1 — Confirm the break in the trend

```runsql
WITH monthly_marketing AS (
  SELECT month, SUM(spend) AS marketing_spend
  FROM marketing_spend
  GROUP BY month
)
SELECT oe.order_month AS month,
       COUNT(*) AS orders,
       ROUND(SUM(oe.net_revenue), 2) AS net_revenue,
       ROUND(SUM(oe.profit_before_marketing) - mm.marketing_spend, 2) AS contribution_profit,
       ROUND((SUM(oe.profit_before_marketing) - mm.marketing_spend) / NULLIF(SUM(oe.net_revenue), 0), 4) AS contribution_margin
FROM order_economics oe
JOIN monthly_marketing mm ON mm.month = oe.order_month
GROUP BY oe.order_month, mm.marketing_spend
ORDER BY oe.order_month;
```

<detail>
   <block-id>blk_demo_ecommerce_monthly_en</block-id>
   <run-date>2026-07-08 10:00:00</run-date>
   <elapsed>12ms</elapsed>
   <row-count>6</row-count>
   <first-row>{"month":"2026-01","orders":220,"net_revenue":33767.8,"contribution_profit":13077.38,"contribution_margin":0.3873}</first-row>
   <result-ref-id>run_demo_ecommerce_monthly_en</result-ref-id>
</detail>

June orders rose from 300 to 375 and net revenue reached $54,016.80. Contribution profit fell by more than half, from $19,183.79 to $9,090.55. This is not a demand problem; it is a unit-economics problem.

## 2 — Find the channel buying unprofitable growth

```runsql
SELECT oe.channel,
       COUNT(*) AS orders,
       ROUND(SUM(oe.net_revenue), 2) AS net_revenue,
       ROUND(ms.spend, 2) AS marketing_spend,
       ROUND(SUM(oe.profit_before_marketing) - ms.spend, 2) AS contribution_profit,
       ROUND((SUM(oe.profit_before_marketing) - ms.spend) / NULLIF(SUM(oe.net_revenue), 0), 4) AS contribution_margin
FROM order_economics oe
JOIN marketing_spend ms ON ms.month = oe.order_month AND ms.channel = oe.channel
WHERE oe.order_month = '2026-06'
GROUP BY oe.channel, ms.spend
ORDER BY contribution_margin ASC;
```

<detail>
   <block-id>blk_demo_ecommerce_channel_en</block-id>
   <run-date>2026-07-08 10:00:00</run-date>
   <elapsed>18ms</elapsed>
   <row-count>5</row-count>
   <first-row>{"channel":"paid_social","orders":152,"net_revenue":20685.8,"marketing_spend":12800,"contribution_profit":-4972.75,"contribution_margin":-0.2404}</first-row>
   <result-ref-id>run_demo_ecommerce_channel_en</result-ref-id>
</detail>

Paid social supplied 152 orders and $20,685.80 of net revenue, but lost $4,972.75 after marketing. Every other channel remained contribution-positive.

## 3 — Separate campaign volume from campaign quality

```runsql
SELECT COALESCE(oe.promotion_code, 'No promotion') AS promotion,
       COUNT(*) AS orders,
       ROUND(SUM(oe.discounts), 2) AS discounts,
       ROUND(SUM(oe.net_revenue), 2) AS net_revenue,
       ROUND(SUM(oe.profit_before_marketing) / NULLIF(SUM(oe.net_revenue), 0), 4) AS margin_before_marketing
FROM order_economics oe
WHERE oe.order_month = '2026-06'
GROUP BY COALESCE(oe.promotion_code, 'No promotion')
ORDER BY orders DESC;
```

<detail>
   <block-id>blk_demo_ecommerce_promotion_en</block-id>
   <run-date>2026-07-08 10:00:00</run-date>
   <elapsed>21ms</elapsed>
   <row-count>3</row-count>
   <first-row>{"promotion":"No promotion","orders":225,"discounts":0,"net_revenue":33970,"margin_before_marketing":0.542}</first-row>
   <result-ref-id>run_demo_ecommerce_promotion_en</result-ref-id>
</detail>

`SUMMER20` created 105 orders but gave away $3,936.40 before acquisition cost. Its pre-marketing margin was 34.6%, compared with 54.2% for orders without a promotion.

## 4 — Identify the product amplifying the loss

```runsql
SELECT p.sku,
       p.name,
       p.category,
       SUM(oi.quantity) AS sold_units,
       COALESCE(SUM(r.quantity), 0) AS returned_units,
       ROUND(COALESCE(SUM(r.quantity), 0) / NULLIF(SUM(oi.quantity), 0), 4) AS return_rate,
       ROUND(SUM(oi.quantity * oi.unit_price - oi.discount_amount) - COALESCE(SUM(r.refund_amount), 0), 2) AS net_revenue,
       ROUND(COALESCE(SUM(r.refund_amount + r.processing_cost), 0), 2) AS return_loss
FROM order_items oi
JOIN orders o ON o.id = oi.order_id
JOIN products p ON p.id = oi.product_id
LEFT JOIN returns r ON r.order_item_id = oi.id
WHERE o.order_date >= '2026-06-01' AND o.order_date < '2026-07-01'
GROUP BY p.id, p.sku, p.name, p.category
HAVING sold_units >= 8
ORDER BY return_rate DESC, return_loss DESC
LIMIT 8;
```

<detail>
   <block-id>blk_demo_ecommerce_sku_en</block-id>
   <run-date>2026-07-08 10:00:00</run-date>
   <elapsed>24ms</elapsed>
   <row-count>8</row-count>
   <first-row>{"sku":"NS-FW-004","name":"TrailFlex Runner","category":"Footwear","sold_units":121,"returned_units":24,"return_rate":0.1983,"net_revenue":10892.8,"return_loss":2941.6}</first-row>
   <result-ref-id>run_demo_ecommerce_sku_en</result-ref-id>
</detail>

TrailFlex Runner was heavily promoted and returned at 19.8%, creating $2,941.60 in refunds and processing loss. The campaign combined the most expensive channel, the deepest discount, and the riskiest SKU.

Open [[en/business-review.stela.canvas|Business Review Canvas →]] to turn these audited results into a decision view, then continue to [[en/03-management-action-plan|3. Management action plan]].
