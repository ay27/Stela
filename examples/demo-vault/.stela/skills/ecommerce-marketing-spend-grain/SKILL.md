---
name: ecommerce-marketing-spend-grain
description: Source excerpts for scoped data definitions; recheck applicability before use.
category: business-glossary
tags: [source-excerpts]
sources: [{"path":"en/01-business-context-and-metrics.md","sha256":"a075a623e19d0dee545664e0b2d3a636bdfe0d6f5a1e2cbeb39d8f48eb29952d"},{"path":"en/02-growth-quality-investigation.md","sha256":"0b013f12e1d12805cf4be113e8145dedacbb2a85e55cb253d9e0596e869ac279"}]
source_tables: ["information_schema.columns"]
---

## Scope
Independent source excerpts; not verified cross-stage population mappings.
## Term Mapping
Source: en/01-business-context-and-metrics.md
> Net revenue = gross sales - discounts - refunds
> Contribution profit = net revenue - product cost - fulfillment cost
>                       - return processing cost - marketing spend
> Contribution margin = contribution profit / net revenue
Source: en/02-growth-quality-investigation.md
> FROM order_economics oe
> JOIN marketing_spend ms ON ms.month = oe.order_month AND ms.channel = oe.channel
> WHERE oe.order_month = '2026-06'
> GROUP BY oe.channel, ms.spend
Source: en/01-business-context-and-metrics.md
> - `marketing_spend` by month and channel
## Rule
Apply only within the cited source scope. Do not infer absent columns or stage conversion from these excerpts.
## Verify
Recheck current schema, population, keys and stage relationships before comparing results.
