---
type: stela-data-note
connection_name: local-mysql
created_at: "2026-07-08T02:00:00.000Z"
---

# 3. Management action plan

## Decision

June did not reveal a broad product-demand problem. Northstar combined three individually risky choices in one campaign:

1. Paid social spend rose fast enough to make the channel contribution-negative.
2. `SUMMER20` reduced pre-marketing margin on the promoted orders.
3. TrailFlex Runner’s 19.8% return rate amplified refunds and handling cost.

## July actions

- Pause broad paid-social scaling until the channel is contribution-positive by cohort.
- Replace the site-wide 20% discount with category-level offers that exclude weak-margin products.
- Remove TrailFlex Runner from acquisition creative, fix its sizing guidance, and monitor return rate weekly.
- Keep organic search and email funded: both produced positive contribution without depending on a deep promotion.

## Ask the Agent to verify and update the Canvas

Configure an AI provider in **Settings → AI**, open [[en/business-review.stela.canvas|the Business Review Canvas]], open the Agent panel, and run this task:

> Use the `ecommerce-unit-economics` Skill and `local-mysql` to verify why June orders and net revenue grew while contribution margin fell. Re-run the relevant SQL, compare channel, promotion, and SKU evidence, then update the currently open Business Review Canvas with a concise management conclusion and an evidence-to-action flow. Do not create a second Canvas.

This is a real Agent run. Its successful `run_sql` results become the refreshed Canvas sources.

## Inspect the real run

After the Agent finishes, open **Agent Dashboard** from the bottom dock. Inspect:

- completion and latency for this Agent run;
- `run_sql`, `load_skill`, and Canvas tool activity;
- the loaded `ecommerce-unit-economics` Skill;
- token use and the redacted trace.

The Dashboard is intentionally empty before you run an Agent. It never ships fictional observability data.

## Reuse the analysis next week

Create a note with `local-mysql`, add a RunSQL block, and press **Mod+Shift+P** inside it. Insert either:

- **Channel contribution / 渠道贡献利润** to repeat the channel review for another period;
- **High-return SKU / 高退货商品** to investigate a category or stricter volume threshold.

Repeated `{{variables}}` edit together, so one date or channel change updates every occurrence. Return to [[README|the Demo home]].
