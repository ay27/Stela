export const DEMO_CONNECTION_NAME = "local-mysql";
export const DEMO_STARTED_AT = Date.UTC(2026, 6, 8, 2, 0, 0);

export interface DemoCustomer {
  id: number;
  joinedAt: string;
  region: string;
  acquisitionChannel: string;
}

export interface DemoProduct {
  id: number;
  sku: string;
  name: string;
  category: string;
  unitPrice: number;
  unitCost: number;
}

export interface DemoOrder {
  id: number;
  customerId: number;
  orderDate: string;
  channel: string;
  promotionCode: string | null;
  fulfillmentCost: number;
}

export interface DemoOrderItem {
  id: number;
  orderId: number;
  productId: number;
  quantity: number;
  unitPrice: number;
  discountAmount: number;
}

export interface DemoReturn {
  id: number;
  orderItemId: number;
  returnedAt: string;
  quantity: number;
  refundAmount: number;
  processingCost: number;
  reason: string;
}

export interface DemoMarketingSpend {
  month: string;
  channel: string;
  spend: number;
}

export interface DemoFixture {
  customers: DemoCustomer[];
  products: DemoProduct[];
  orders: DemoOrder[];
  orderItems: DemoOrderItem[];
  returns: DemoReturn[];
  marketingSpend: DemoMarketingSpend[];
}

export interface DemoQueryResult {
  id: "monthly" | "kpi" | "channel" | "promotion" | "sku";
  sql: string;
  columns: Array<{ name: string; typeName: string }>;
  rows: unknown[][];
}

const MONTHS = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"] as const;
const CHANNELS = ["organic_search", "email", "paid_search", "paid_social", "affiliates"] as const;
const MONTHLY_ORDERS = [220, 235, 250, 270, 300, 375] as const;
const NORMAL_CHANNEL_WEIGHTS = [0.27, 0.23, 0.22, 0.18, 0.1] as const;
const JUNE_CHANNEL_WEIGHTS = [0.18, 0.16, 0.16, 0.4, 0.1] as const;

export const DEMO_QUERIES: Record<DemoQueryResult["id"], string> = {
  monthly: `WITH monthly_marketing AS (
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
ORDER BY oe.order_month;`,
  kpi: `WITH monthly AS (
  SELECT oe.order_month AS month,
         COUNT(*) AS orders,
         SUM(oe.net_revenue) AS net_revenue,
         SUM(oe.profit_before_marketing) - mm.marketing_spend AS contribution_profit
  FROM order_economics oe
  JOIN (
    SELECT month, SUM(spend) AS marketing_spend
    FROM marketing_spend
    GROUP BY month
  ) mm ON mm.month = oe.order_month
  WHERE oe.order_month IN ('2026-05', '2026-06')
  GROUP BY oe.order_month, mm.marketing_spend
), paired AS (
  SELECT MAX(CASE WHEN month = '2026-05' THEN orders END) AS may_orders,
         MAX(CASE WHEN month = '2026-06' THEN orders END) AS june_orders,
         MAX(CASE WHEN month = '2026-05' THEN net_revenue END) AS may_revenue,
         MAX(CASE WHEN month = '2026-06' THEN net_revenue END) AS june_revenue,
         MAX(CASE WHEN month = '2026-05' THEN contribution_profit END) AS may_profit,
         MAX(CASE WHEN month = '2026-06' THEN contribution_profit END) AS june_profit,
         MAX(CASE WHEN month = '2026-05' THEN contribution_profit / NULLIF(net_revenue, 0) END) AS may_margin,
         MAX(CASE WHEN month = '2026-06' THEN contribution_profit / NULLIF(net_revenue, 0) END) AS june_margin
  FROM monthly
), paid_social AS (
  SELECT COUNT(*) AS paid_social_orders,
         SUM(oe.profit_before_marketing) - ms.spend AS contribution_profit
  FROM order_economics oe
  JOIN marketing_spend ms ON ms.month = oe.order_month AND ms.channel = oe.channel
  WHERE oe.order_month = '2026-06' AND oe.channel = 'paid_social'
  GROUP BY ms.spend
), trailflex AS (
  SELECT SUM(oi.quantity) AS sold_units,
         COALESCE(SUM(r.quantity), 0) AS returned_units,
         COALESCE(SUM(r.refund_amount + r.processing_cost), 0) AS return_loss
  FROM order_items oi
  JOIN orders o ON o.id = oi.order_id
  JOIN products p ON p.id = oi.product_id
  LEFT JOIN returns r ON r.order_item_id = oi.id
  WHERE o.order_date >= '2026-06-01' AND o.order_date < '2026-07-01'
    AND p.sku = 'NS-FW-004'
)
SELECT ROUND((june_orders - may_orders) / may_orders, 4) AS order_growth,
       ROUND((june_revenue - may_revenue) / may_revenue, 4) AS revenue_growth,
       ROUND(may_margin, 4) AS may_contribution_margin,
       ROUND(june_margin, 4) AS june_contribution_margin,
       ROUND(june_margin - may_margin, 4) AS margin_change,
       ROUND((june_profit - may_profit) / may_profit, 4) AS contribution_profit_change,
       ROUND(paid_social.contribution_profit, 2) AS paid_social_contribution_profit,
       ROUND(paid_social.paid_social_orders / june_orders, 4) AS paid_social_order_share,
       ROUND(trailflex.returned_units / NULLIF(trailflex.sold_units, 0), 4) AS trailflex_return_rate,
       ROUND(trailflex.return_loss, 2) AS trailflex_return_loss
FROM paired
CROSS JOIN paid_social
CROSS JOIN trailflex;`,
  channel: `SELECT oe.channel,
       COUNT(*) AS orders,
       ROUND(SUM(oe.net_revenue), 2) AS net_revenue,
       ROUND(ms.spend, 2) AS marketing_spend,
       ROUND(SUM(oe.profit_before_marketing) - ms.spend, 2) AS contribution_profit,
       ROUND((SUM(oe.profit_before_marketing) - ms.spend) / NULLIF(SUM(oe.net_revenue), 0), 4) AS contribution_margin
FROM order_economics oe
JOIN marketing_spend ms ON ms.month = oe.order_month AND ms.channel = oe.channel
WHERE oe.order_month = '2026-06'
GROUP BY oe.channel, ms.spend
ORDER BY contribution_margin ASC;`,
  promotion: `SELECT COALESCE(oe.promotion_code, 'No promotion') AS promotion,
       COUNT(*) AS orders,
       ROUND(SUM(oe.discounts), 2) AS discounts,
       ROUND(SUM(oe.net_revenue), 2) AS net_revenue,
       ROUND(SUM(oe.profit_before_marketing) / NULLIF(SUM(oe.net_revenue), 0), 4) AS margin_before_marketing
FROM order_economics oe
WHERE oe.order_month = '2026-06'
GROUP BY COALESCE(oe.promotion_code, 'No promotion')
ORDER BY orders DESC;`,
  sku: `SELECT p.sku,
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
LIMIT 8;`,
};

const PRODUCT_ROWS: Array<Omit<DemoProduct, "id">> = [
  ["NS-FW-001", "Ridge Hiker", "Footwear", 138, 57],
  ["NS-FW-002", "Coast Runner", "Footwear", 118, 49],
  ["NS-FW-003", "Camp Slide", "Footwear", 58, 21],
  ["NS-FW-004", "TrailFlex Runner", "Footwear", 128, 54],
  ["NS-FW-005", "Alpine Boot", "Footwear", 168, 74],
  ["NS-FW-006", "Everyday Sneaker", "Footwear", 98, 39],
  ["NS-AP-001", "Summit Shell", "Apparel", 148, 58],
  ["NS-AP-002", "Merino Base Layer", "Apparel", 88, 31],
  ["NS-AP-003", "Trail Short", "Apparel", 68, 23],
  ["NS-AP-004", "Field Fleece", "Apparel", 108, 41],
  ["NS-AP-005", "Packable Vest", "Apparel", 118, 43],
  ["NS-AP-006", "Everyday Tee", "Apparel", 42, 12],
  ["NS-BG-001", "Transit Pack 22L", "Bags", 128, 44],
  ["NS-BG-002", "Weekender Duffel", "Bags", 158, 58],
  ["NS-BG-003", "Trail Sling", "Bags", 72, 24],
  ["NS-BG-004", "Daybreak Tote", "Bags", 64, 19],
  ["NS-BG-005", "Summit Pack 35L", "Bags", 188, 71],
  ["NS-BG-006", "Packing Cube Set", "Bags", 48, 13],
  ["NS-AC-001", "Insulated Bottle", "Accessories", 38, 11],
  ["NS-AC-002", "Trail Cap", "Accessories", 32, 8],
  ["NS-AC-003", "Merino Sock Set", "Accessories", 34, 9],
  ["NS-AC-004", "Camp Blanket", "Accessories", 78, 27],
  ["NS-AC-005", "Travel Organizer", "Accessories", 44, 12],
  ["NS-AC-006", "Utility Carabiner Set", "Accessories", 24, 6],
].map(([sku, name, category, unitPrice, unitCost], index) => ({
  id: index + 1,
  sku: sku as string,
  name: name as string,
  category: category as string,
  unitPrice: unitPrice as number,
  unitCost: unitCost as number,
}));

function rng(seed = 20260630): () => number {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let next = value;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

function money(value: number): number {
  return Math.round(value * 100) / 100;
}

function chooseWeighted<T>(values: readonly T[], weights: readonly number[], random: () => number): T {
  const needle = random();
  let cumulative = 0;
  for (let index = 0; index < values.length; index += 1) {
    cumulative += weights[index] ?? 0;
    if (needle < cumulative) return values[index]!;
  }
  return values[values.length - 1]!;
}

export function buildDemoFixture(): DemoFixture {
  const random = rng();
  const regions = ["West", "Northeast", "South", "Midwest"];
  const customers: DemoCustomer[] = Array.from({ length: 600 }, (_, index) => ({
    id: index + 1,
    joinedAt: `2025-${String((index % 12) + 1).padStart(2, "0")}-${String((index % 27) + 1).padStart(2, "0")}`,
    region: regions[index % regions.length]!,
    acquisitionChannel: CHANNELS[index % CHANNELS.length]!,
  }));
  const orders: DemoOrder[] = [];
  const orderItems: DemoOrderItem[] = [];
  const returns: DemoReturn[] = [];
  let orderId = 1;
  let itemId = 1;
  let returnId = 1;

  for (const [monthIndex, month] of MONTHS.entries()) {
    const isJune = month === "2026-06";
    const weights = isJune ? JUNE_CHANNEL_WEIGHTS : NORMAL_CHANNEL_WEIGHTS;
    for (let localOrder = 0; localOrder < MONTHLY_ORDERS[monthIndex]!; localOrder += 1) {
      const channel = chooseWeighted(CHANNELS, weights, random);
      const promotionCode = isJune && channel === "paid_social" && random() < 0.72
        ? "SUMMER20"
        : random() < (isJune ? 0.13 : 0.09) ? "WELCOME10" : null;
      const orderDate = `${month}-${String(1 + ((localOrder * 7 + Math.floor(random() * 11)) % 28)).padStart(2, "0")}`;
      orders.push({
        id: orderId,
        customerId: 1 + Math.floor(random() * customers.length),
        orderDate,
        channel,
        promotionCode,
        fulfillmentCost: money((isJune && channel === "paid_social" ? 9.5 : 6.4) + random() * 2),
      });
      const lineCount = random() < 0.12 ? 3 : random() < 0.58 ? 2 : 1;
      for (let line = 0; line < lineCount; line += 1) {
        const promotedTrailFlex = isJune && channel === "paid_social" && random() < 0.38;
        const product = promotedTrailFlex
          ? PRODUCT_ROWS[3]!
          : PRODUCT_ROWS[Math.floor(random() * PRODUCT_ROWS.length)]!;
        const discountRate = promotionCode === "SUMMER20" ? 0.2 : promotionCode === "WELCOME10" ? 0.1 : 0;
        const discountAmount = money(product.unitPrice * discountRate);
        const currentItemId = itemId;
        orderItems.push({
          id: currentItemId,
          orderId,
          productId: product.id,
          quantity: 1,
          unitPrice: product.unitPrice,
          discountAmount,
        });
        const trailFlexRisk = product.sku === "NS-FW-004" ? (isJune ? 0.31 : 0.14) : 0;
        const generalRisk = product.category === "Footwear" ? 0.075 : 0.035;
        if (random() < Math.max(trailFlexRisk, generalRisk) + (promotionCode === "SUMMER20" ? 0.018 : 0)) {
          returns.push({
            id: returnId,
            orderItemId: currentItemId,
            returnedAt: `${isJune ? "2026-07" : month}-${String(1 + ((localOrder * 5 + line) % 28)).padStart(2, "0")}`,
            quantity: 1,
            refundAmount: money(product.unitPrice - discountAmount),
            processingCost: product.category === "Footwear" ? 9.5 : 6.5,
            reason: product.sku === "NS-FW-004" ? "Sizing mismatch" : random() < 0.5 ? "Fit or preference" : "Changed mind",
          });
          returnId += 1;
        }
        itemId += 1;
      }
      orderId += 1;
    }
  }

  const baseSpend: Record<(typeof CHANNELS)[number], number> = {
    organic_search: 280,
    email: 420,
    paid_search: 2_150,
    paid_social: 1_850,
    affiliates: 780,
  };
  const marketingSpend = MONTHS.flatMap((month, monthIndex) => CHANNELS.map((channel) => ({
    month,
    channel,
    spend: money(month === "2026-06" && channel === "paid_social"
      ? 12_800
      : baseSpend[channel] * (1 + monthIndex * 0.035)),
  })));

  return { customers, products: PRODUCT_ROWS, orders, orderItems, returns, marketingSpend };
}

interface OrderEconomics {
  order: DemoOrder;
  grossSales: number;
  discounts: number;
  cogs: number;
  refunds: number;
  returnCost: number;
  netRevenue: number;
  profitBeforeMarketing: number;
}

function economics(fixture: DemoFixture): OrderEconomics[] {
  const products = new Map(fixture.products.map((product) => [product.id, product]));
  const itemsByOrder = new Map<number, DemoOrderItem[]>();
  for (const item of fixture.orderItems) itemsByOrder.set(item.orderId, [...(itemsByOrder.get(item.orderId) ?? []), item]);
  const returnsByItem = new Map(fixture.returns.map((item) => [item.orderItemId, item]));
  return fixture.orders.map((order) => {
    const items = itemsByOrder.get(order.id) ?? [];
    const grossSales = items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
    const discounts = items.reduce((sum, item) => sum + item.discountAmount, 0);
    const cogs = items.reduce((sum, item) => sum + item.quantity * products.get(item.productId)!.unitCost, 0);
    const refunds = items.reduce((sum, item) => sum + (returnsByItem.get(item.id)?.refundAmount ?? 0), 0);
    const returnCost = items.reduce((sum, item) => sum + (returnsByItem.get(item.id)?.processingCost ?? 0), 0);
    const netRevenue = money(grossSales - discounts - refunds);
    return {
      order,
      grossSales: money(grossSales),
      discounts: money(discounts),
      cogs: money(cogs),
      refunds: money(refunds),
      returnCost: money(returnCost),
      netRevenue,
      profitBeforeMarketing: money(netRevenue - cogs - order.fulfillmentCost - returnCost),
    };
  });
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Math.round((numerator / denominator) * 10_000) / 10_000;
}

function fourDecimals(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export function buildDemoQueryResults(fixture: DemoFixture): DemoQueryResult[] {
  const orderEconomics = economics(fixture);
  const marketing = (month: string, channel?: string) => fixture.marketingSpend
    .filter((item) => item.month === month && (!channel || item.channel === channel))
    .reduce((sum, item) => sum + item.spend, 0);
  const monthlyRows = MONTHS.map((month) => {
    const rows = orderEconomics.filter((item) => item.order.orderDate.startsWith(month));
    const netRevenue = money(rows.reduce((sum, item) => sum + item.netRevenue, 0));
    const contributionProfit = money(rows.reduce((sum, item) => sum + item.profitBeforeMarketing, 0) - marketing(month));
    return [month, rows.length, netRevenue, contributionProfit, ratio(contributionProfit, netRevenue)];
  });
  const may = monthlyRows[4]!;
  const june = monthlyRows[5]!;
  const juneEconomics = orderEconomics.filter((item) => item.order.orderDate.startsWith("2026-06"));
  const channelRows = CHANNELS.map((channel) => {
    const rows = juneEconomics.filter((item) => item.order.channel === channel);
    const netRevenue = money(rows.reduce((sum, item) => sum + item.netRevenue, 0));
    const spend = marketing("2026-06", channel);
    const contributionProfit = money(rows.reduce((sum, item) => sum + item.profitBeforeMarketing, 0) - spend);
    return [channel, rows.length, netRevenue, spend, contributionProfit, ratio(contributionProfit, netRevenue)];
  }).sort((a, b) => Number(a[5]) - Number(b[5]));
  const promotionRows = ["SUMMER20", "WELCOME10", "No promotion"].map((promotion) => {
    const rows = juneEconomics.filter((item) => (item.order.promotionCode ?? "No promotion") === promotion);
    const discounts = money(rows.reduce((sum, item) => sum + item.discounts, 0));
    const netRevenue = money(rows.reduce((sum, item) => sum + item.netRevenue, 0));
    const margin = ratio(rows.reduce((sum, item) => sum + item.profitBeforeMarketing, 0), netRevenue);
    return [promotion, rows.length, discounts, netRevenue, margin];
  }).sort((a, b) => Number(b[1]) - Number(a[1]));
  const productMap = new Map(fixture.products.map((product) => [product.id, product]));
  const orderMap = new Map(fixture.orders.map((order) => [order.id, order]));
  const returnMap = new Map(fixture.returns.map((item) => [item.orderItemId, item]));
  const skuStats = new Map<number, { sold: number; returned: number; revenue: number; loss: number }>();
  for (const item of fixture.orderItems) {
    if (!orderMap.get(item.orderId)?.orderDate.startsWith("2026-06")) continue;
    const stat = skuStats.get(item.productId) ?? { sold: 0, returned: 0, revenue: 0, loss: 0 };
    const returned = returnMap.get(item.id);
    stat.sold += item.quantity;
    stat.returned += returned?.quantity ?? 0;
    stat.revenue += item.quantity * item.unitPrice - item.discountAmount - (returned?.refundAmount ?? 0);
    stat.loss += (returned?.refundAmount ?? 0) + (returned?.processingCost ?? 0);
    skuStats.set(item.productId, stat);
  }
  const skuRows = [...skuStats.entries()].filter(([, stat]) => stat.sold >= 8).map(([productId, stat]) => {
    const product = productMap.get(productId)!;
    return [product.sku, product.name, product.category, stat.sold, stat.returned, ratio(stat.returned, stat.sold), money(stat.revenue), money(stat.loss)];
  }).sort((a, b) => Number(b[5]) - Number(a[5]) || Number(b[7]) - Number(a[7])).slice(0, 8);
  const paidSocial = channelRows.find((row) => row[0] === "paid_social")!;
  const trailflex = skuRows.find((row) => row[0] === "NS-FW-004")!;
  const kpiRows = [[
    ratio(Number(june[1]) - Number(may[1]), Number(may[1])),
    ratio(Number(june[2]) - Number(may[2]), Number(may[2])),
    Number(may[4]),
    Number(june[4]),
    fourDecimals(Number(june[4]) - Number(may[4])),
    ratio(Number(june[3]) - Number(may[3]), Number(may[3])),
    Number(paidSocial[4]),
    ratio(Number(paidSocial[1]), Number(june[1])),
    Number(trailflex[5]),
    Number(trailflex[7]),
  ]];

  return [
    { id: "monthly", sql: DEMO_QUERIES.monthly, columns: [
      { name: "month", typeName: "VARCHAR" }, { name: "orders", typeName: "BIGINT" },
      { name: "net_revenue", typeName: "DECIMAL" }, { name: "contribution_profit", typeName: "DECIMAL" },
      { name: "contribution_margin", typeName: "DECIMAL" },
    ], rows: monthlyRows },
    { id: "kpi", sql: DEMO_QUERIES.kpi, columns: [
      { name: "order_growth", typeName: "DECIMAL" }, { name: "revenue_growth", typeName: "DECIMAL" },
      { name: "may_contribution_margin", typeName: "DECIMAL" }, { name: "june_contribution_margin", typeName: "DECIMAL" },
      { name: "margin_change", typeName: "DECIMAL" }, { name: "contribution_profit_change", typeName: "DECIMAL" },
      { name: "paid_social_contribution_profit", typeName: "DECIMAL" }, { name: "paid_social_order_share", typeName: "DECIMAL" },
      { name: "trailflex_return_rate", typeName: "DECIMAL" }, { name: "trailflex_return_loss", typeName: "DECIMAL" },
    ], rows: kpiRows },
    { id: "channel", sql: DEMO_QUERIES.channel, columns: [
      { name: "channel", typeName: "VARCHAR" }, { name: "orders", typeName: "BIGINT" },
      { name: "net_revenue", typeName: "DECIMAL" }, { name: "marketing_spend", typeName: "DECIMAL" },
      { name: "contribution_profit", typeName: "DECIMAL" }, { name: "contribution_margin", typeName: "DECIMAL" },
    ], rows: channelRows },
    { id: "promotion", sql: DEMO_QUERIES.promotion, columns: [
      { name: "promotion", typeName: "VARCHAR" }, { name: "orders", typeName: "BIGINT" },
      { name: "discounts", typeName: "DECIMAL" }, { name: "net_revenue", typeName: "DECIMAL" },
      { name: "margin_before_marketing", typeName: "DECIMAL" },
    ], rows: promotionRows },
    { id: "sku", sql: DEMO_QUERIES.sku, columns: [
      { name: "sku", typeName: "VARCHAR" }, { name: "name", typeName: "VARCHAR" }, { name: "category", typeName: "VARCHAR" },
      { name: "sold_units", typeName: "DECIMAL" }, { name: "returned_units", typeName: "DECIMAL" },
      { name: "return_rate", typeName: "DECIMAL" }, { name: "net_revenue", typeName: "DECIMAL" }, { name: "return_loss", typeName: "DECIMAL" },
    ], rows: skuRows },
  ];
}
