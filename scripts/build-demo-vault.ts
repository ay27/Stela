import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  buildDemoFixture,
  buildDemoQueryResults,
  DEMO_CONNECTION_NAME,
  DEMO_STARTED_AT,
} from "./demo-vault-fixture";

const root = path.join(process.cwd(), "examples", "demo-vault");
const fixture = buildDemoFixture();
const results = buildDemoQueryResults(fixture);

function sqlString(value: string | null): string {
  return value === null ? "NULL" : `'${value.replaceAll("'", "''")}'`;
}

function rowsInsert(table: string, columns: string[], rows: Array<Array<string | number | null>>): string {
  const batches: string[] = [];
  for (let index = 0; index < rows.length; index += 400) {
    const values = rows.slice(index, index + 400).map((row) => `  (${row.map((value) => typeof value === "string" || value === null ? sqlString(value) : String(value)).join(", ")})`).join(",\n");
    batches.push(`INSERT INTO ${table} (${columns.join(", ")}) VALUES\n${values};`);
  }
  return batches.join("\n\n");
}

const schema = `DROP VIEW IF EXISTS order_economics;
DROP TABLE IF EXISTS returns;
DROP TABLE IF EXISTS order_items;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS marketing_spend;
DROP TABLE IF EXISTS products;
DROP TABLE IF EXISTS customers;

CREATE TABLE customers (
  id INT PRIMARY KEY,
  joined_at DATE NOT NULL,
  region VARCHAR(32) NOT NULL,
  acquisition_channel VARCHAR(32) NOT NULL
);

CREATE TABLE products (
  id INT PRIMARY KEY,
  sku VARCHAR(32) NOT NULL UNIQUE,
  name VARCHAR(128) NOT NULL,
  category VARCHAR(32) NOT NULL,
  unit_price DECIMAL(10,2) NOT NULL,
  unit_cost DECIMAL(10,2) NOT NULL
);

CREATE TABLE orders (
  id INT PRIMARY KEY,
  customer_id INT NOT NULL,
  order_date DATE NOT NULL,
  channel VARCHAR(32) NOT NULL,
  promotion_code VARCHAR(32),
  fulfillment_cost DECIMAL(10,2) NOT NULL,
  CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES customers(id),
  INDEX idx_orders_date_channel (order_date, channel)
);

CREATE TABLE order_items (
  id INT PRIMARY KEY,
  order_id INT NOT NULL,
  product_id INT NOT NULL,
  quantity INT NOT NULL,
  unit_price DECIMAL(10,2) NOT NULL,
  discount_amount DECIMAL(10,2) NOT NULL,
  CONSTRAINT fk_order_items_order FOREIGN KEY (order_id) REFERENCES orders(id),
  CONSTRAINT fk_order_items_product FOREIGN KEY (product_id) REFERENCES products(id),
  INDEX idx_order_items_order (order_id),
  INDEX idx_order_items_product (product_id)
);

CREATE TABLE returns (
  id INT PRIMARY KEY,
  order_item_id INT NOT NULL UNIQUE,
  returned_at DATE NOT NULL,
  quantity INT NOT NULL,
  refund_amount DECIMAL(10,2) NOT NULL,
  processing_cost DECIMAL(10,2) NOT NULL,
  reason VARCHAR(64) NOT NULL,
  CONSTRAINT fk_returns_order_item FOREIGN KEY (order_item_id) REFERENCES order_items(id)
);

CREATE TABLE marketing_spend (
  month CHAR(7) NOT NULL,
  channel VARCHAR(32) NOT NULL,
  spend DECIMAL(10,2) NOT NULL,
  PRIMARY KEY (month, channel)
);

CREATE VIEW order_economics AS
SELECT o.id AS order_id,
       o.order_date,
       DATE_FORMAT(o.order_date, '%Y-%m') AS order_month,
       o.channel,
       o.promotion_code,
       it.gross_sales,
       it.discounts,
       it.cogs,
       COALESCE(rt.refunds, 0) AS refunds,
       COALESCE(rt.return_cost, 0) AS return_cost,
       o.fulfillment_cost,
       it.gross_sales - it.discounts - COALESCE(rt.refunds, 0) AS net_revenue,
       it.gross_sales - it.discounts - COALESCE(rt.refunds, 0)
         - it.cogs - o.fulfillment_cost - COALESCE(rt.return_cost, 0) AS profit_before_marketing
FROM orders o
JOIN (
  SELECT oi.order_id,
         SUM(oi.quantity * oi.unit_price) AS gross_sales,
         SUM(oi.discount_amount) AS discounts,
         SUM(oi.quantity * p.unit_cost) AS cogs
  FROM order_items oi JOIN products p ON p.id = oi.product_id
  GROUP BY oi.order_id
) it ON it.order_id = o.id
LEFT JOIN (
  SELECT oi.order_id,
         SUM(r.refund_amount) AS refunds,
         SUM(r.processing_cost) AS return_cost
  FROM returns r JOIN order_items oi ON oi.id = r.order_item_id
  GROUP BY oi.order_id
) rt ON rt.order_id = o.id;
`;

const data = [
  rowsInsert("customers", ["id", "joined_at", "region", "acquisition_channel"], fixture.customers.map((item) => [item.id, item.joinedAt, item.region, item.acquisitionChannel])),
  rowsInsert("products", ["id", "sku", "name", "category", "unit_price", "unit_cost"], fixture.products.map((item) => [item.id, item.sku, item.name, item.category, item.unitPrice, item.unitCost])),
  rowsInsert("orders", ["id", "customer_id", "order_date", "channel", "promotion_code", "fulfillment_cost"], fixture.orders.map((item) => [item.id, item.customerId, item.orderDate, item.channel, item.promotionCode, item.fulfillmentCost])),
  rowsInsert("order_items", ["id", "order_id", "product_id", "quantity", "unit_price", "discount_amount"], fixture.orderItems.map((item) => [item.id, item.orderId, item.productId, item.quantity, item.unitPrice, item.discountAmount])),
  rowsInsert("returns", ["id", "order_item_id", "returned_at", "quantity", "refund_amount", "processing_cost", "reason"], fixture.returns.map((item) => [item.id, item.orderItemId, item.returnedAt, item.quantity, item.refundAmount, item.processingCost, item.reason])),
  rowsInsert("marketing_spend", ["month", "channel", "spend"], fixture.marketingSpend.map((item) => [item.month, item.channel, item.spend])),
].join("\n\n");

const history = ["en", "zh"].flatMap((locale) => results.map((result, index) => {
  const runId = `run_demo_ecommerce_${result.id}_${locale}`;
  return JSON.stringify({
    v: 1,
    runId,
    deviceId: "stela-demo",
    appendedAt: DEMO_STARTED_AT + index,
    record: {
      runId,
      blockId: `blk_demo_ecommerce_${result.id}_${locale}`,
      sql: result.sql,
      status: "ok",
      message: null,
      startedAt: DEMO_STARTED_AT + index,
      elapsedMs: 12 + index * 3,
      rowCount: result.rows.length,
      connectionName: DEMO_CONNECTION_NAME,
      notePath: null,
    },
    columns: result.columns,
    rows: result.rows,
  });
})).join("\n") + "\n";

function buildCanvas(locale: "en" | "zh") {
  const zh = locale === "zh";
  const runId = (id: string) => `run_demo_ecommerce_${id}_${locale}`;
  const result = (id: string) => results.find((item) => item.id === id)!;
  return {
    kind: "stela-analysis-canvas",
    version: 1,
    id: `demo_ecommerce_canvas_${locale}`,
    title: zh ? "Northstar 六月经营复盘" : "Northstar June Business Review",
    status: "complete",
    createdAt: DEMO_STARTED_AT,
    updatedAt: DEMO_STARTED_AT,
    createdBySessionId: null,
    sources: [
      { id: "kpi", title: zh ? "六月增长质量" : "June growth quality", connectionName: DEMO_CONNECTION_NAME, sql: result("kpi").sql, lastRunId: runId("kpi"), lastRunAt: DEMO_STARTED_AT, lastError: null },
      { id: "monthly", title: zh ? "月度经营趋势" : "Monthly operating trend", connectionName: DEMO_CONNECTION_NAME, sql: result("monthly").sql, lastRunId: runId("monthly"), lastRunAt: DEMO_STARTED_AT, lastError: null },
      { id: "channel", title: zh ? "六月渠道贡献" : "June channel contribution", connectionName: DEMO_CONNECTION_NAME, sql: result("channel").sql, lastRunId: runId("channel"), lastRunAt: DEMO_STARTED_AT, lastError: null },
      { id: "promotion", title: zh ? "六月促销质量" : "June promotion quality", connectionName: DEMO_CONNECTION_NAME, sql: result("promotion").sql, lastRunId: runId("promotion"), lastRunAt: DEMO_STARTED_AT, lastError: null },
      { id: "sku", title: zh ? "六月高退货商品" : "June high-return products", connectionName: DEMO_CONNECTION_NAME, sql: result("sku").sql, lastRunId: runId("sku"), lastRunAt: DEMO_STARTED_AT, lastError: null },
    ],
    sections: [
      {
        id: "executive_summary",
        title: zh ? "经营摘要" : "Executive summary",
        description: zh ? "订单和收入增长，但利润质量发生断裂。" : "Orders and revenue grew while profit quality broke down.",
        cards: [
          { id: "order_growth", type: "kpi", sourceId: "kpi", title: zh ? "订单环比" : "Order growth", value: { field: "order_growth", format: { kind: "percent", input: "ratio", maximumFractionDigits: 1 } }, label: zh ? "五月至六月" : "May to June", width: "third" },
          { id: "revenue_growth", type: "kpi", sourceId: "kpi", title: zh ? "净收入环比" : "Net revenue growth", value: { field: "revenue_growth", format: { kind: "percent", input: "ratio", maximumFractionDigits: 1 } }, label: zh ? "五月至六月" : "May to June", width: "third" },
          { id: "june_margin", type: "kpi", sourceId: "kpi", title: zh ? "六月贡献利润率" : "June contribution margin", value: { field: "june_contribution_margin", format: { kind: "percent", input: "ratio", maximumFractionDigits: 1 } }, label: zh ? "五月为 42.2%" : "42.2% in May", width: "third" },
          { id: "management_readout", type: "markdown", markdown: zh
            ? "### 增长是买来的，而且买得太贵\n付费社交、全场八折和 TrailFlex Runner 的高退货被叠加在同一批订单上，使六月贡献利润率下降 **25 个百分点**。"
            : "### Growth was bought—and bought too expensively\nPaid social, a site-wide 20% discount, and TrailFlex Runner returns converged in the same orders, cutting contribution margin by **25 percentage points**.", width: "full" },
        ],
      },
      {
        id: "statistical_evidence",
        title: zh ? "统计证据" : "Statistical evidence",
        description: zh ? "三个相互独立的切面，定位六月利润质量下滑发生在哪里。" : "Three independent cuts locate where June profit quality broke down.",
        cards: [
          { id: "profit_change", type: "kpi", sourceId: "kpi", title: zh ? "贡献利润环比" : "Contribution profit change", value: { field: "contribution_profit_change", format: { kind: "percent", input: "ratio", maximumFractionDigits: 1 } }, label: zh ? "$19,184 → $9,091" : "$19,184 → $9,091", width: "third" },
          { id: "paid_social_loss", type: "kpi", sourceId: "kpi", title: zh ? "付费社交贡献利润" : "Paid social contribution", value: { field: "paid_social_contribution_profit", format: { kind: "currency", currency: "USD", maximumFractionDigits: 0 } }, label: zh ? "152 单，占六月订单 40.5%" : "152 orders · 40.5% of June volume", width: "third" },
          { id: "trailflex_returns", type: "kpi", sourceId: "kpi", title: zh ? "TrailFlex 退货率" : "TrailFlex return rate", value: { field: "trailflex_return_rate", format: { kind: "percent", input: "ratio", maximumFractionDigits: 1 } }, label: zh ? "退货损失 $2,942" : "$2,942 return loss", width: "third" },
        ],
      },
      {
        id: "evidence",
        title: zh ? "证据链" : "Evidence chain",
        description: zh ? "从总体趋势逐层下钻到渠道、活动和商品。" : "Move from the trend to channel, campaign, and product evidence.",
        cards: [
          {
            id: "monthly_trend", type: "chart", sourceId: "monthly", title: zh ? "收入增长，利润率下滑" : "Revenue up, margin down",
            chart: {
              title: zh ? "月度净收入与贡献利润率" : "Monthly net revenue and contribution margin",
              preset: "comparison",
              fields: {
                month: { field: "month", type: "ordinal", title: zh ? "月份" : "Month" },
                revenue: { field: "net_revenue", type: "quantitative", title: zh ? "净收入" : "Net revenue", format: { kind: "currency", currency: "USD", maximumFractionDigits: 0 } },
                margin: { field: "contribution_margin", type: "quantitative", title: zh ? "贡献利润率" : "Contribution margin", format: { kind: "percent", input: "ratio", maximumFractionDigits: 1 } },
              },
              layers: [
                { mark: "line", encoding: { x: "month", y: "revenue" }, yAxis: "left", stack: "none" },
                { mark: "line", encoding: { x: "month", y: "margin" }, yAxis: "right", stack: "none" },
              ],
            },
            width: "full",
          },
          {
            id: "channel_rank", type: "chart", sourceId: "channel", title: zh ? "渠道贡献利润" : "Channel contribution profit",
            chart: {
              title: zh ? "付费社交是唯一亏损渠道" : "Paid social is the only loss-making channel",
              preset: "ranking",
              fields: {
                channel: { field: "channel", type: "nominal", title: zh ? "渠道" : "Channel" },
                profit: { field: "contribution_profit", type: "quantitative", title: zh ? "贡献利润" : "Contribution profit", format: { kind: "currency", currency: "USD", maximumFractionDigits: 0 } },
              },
              layers: [{ mark: "bar", encoding: { x: "profit", y: "channel" }, yAxis: "left", stack: "none" }],
            },
            width: "half",
          },
          { id: "promotion_table", type: "table", sourceId: "promotion", title: zh ? "促销质量" : "Promotion quality", columns: [
            { field: "promotion", title: zh ? "促销" : "Promotion" },
            { field: "orders", title: zh ? "订单" : "Orders", format: { kind: "number", maximumFractionDigits: 0 } },
            { field: "discounts", title: zh ? "折扣" : "Discounts", format: { kind: "currency", currency: "USD", maximumFractionDigits: 0 } },
            { field: "margin_before_marketing", title: zh ? "营销前利润率" : "Pre-marketing margin", format: { kind: "percent", input: "ratio", maximumFractionDigits: 1 } },
          ], maxRows: 5, width: "half" },
          { id: "sku_table", type: "table", sourceId: "sku", title: zh ? "高退货商品" : "High-return products", columns: [
            { field: "sku", title: "SKU" },
            { field: "name", title: zh ? "商品" : "Product" },
            { field: "sold_units", title: zh ? "销量" : "Units", format: { kind: "number", maximumFractionDigits: 0 } },
            { field: "return_rate", title: zh ? "退货率" : "Return rate", format: { kind: "percent", input: "ratio", maximumFractionDigits: 1 } },
            { field: "return_loss", title: zh ? "退货损失" : "Return loss", format: { kind: "currency", currency: "USD", maximumFractionDigits: 0 } },
          ], maxRows: 8, width: "full" },
        ],
      },
      {
        id: "action",
        title: zh ? "从证据到行动" : "Evidence to action",
        description: zh ? "保留需求，修复增长机制。" : "Keep the demand; repair the growth mechanism.",
        cards: [{
          id: "action_flow", type: "flow", title: zh ? "七月调整路径" : "July response", direction: "LR", width: "full",
          nodes: [
            { id: "signal", kind: "source", label: zh ? "利润率断裂" : "Margin break", description: zh ? "42.2% → 16.8%" : "42.2% → 16.8%", tone: "danger" },
            { id: "channel", kind: "step", label: zh ? "收缩低效投放" : "Reduce weak spend", description: zh ? "付费社交贡献为负" : "Paid social contribution is negative", tone: "warning" },
            { id: "offer", kind: "step", label: zh ? "替换全场折扣" : "Replace site-wide offer", description: zh ? "改为按品类优惠" : "Use category-level offers", tone: "warning" },
            { id: "product", kind: "step", label: zh ? "修复尺码与退货" : "Fix sizing and returns", description: "TrailFlex Runner", tone: "info" },
            { id: "gate", kind: "decision", label: zh ? "渠道恢复正贡献？" : "Channel positive again?", description: zh ? "按周复核" : "Review weekly", tone: "neutral" },
            { id: "scale", kind: "result", label: zh ? "再扩大增长" : "Scale again", description: zh ? "利润质量先于规模" : "Quality before volume", tone: "success" },
          ],
          edges: [
            { id: "signal_channel", source: "signal", target: "channel" },
            { id: "channel_offer", source: "channel", target: "offer" },
            { id: "offer_product", source: "offer", target: "product" },
            { id: "product_gate", source: "product", target: "gate" },
            { id: "gate_scale", source: "gate", target: "scale", label: zh ? "是" : "yes", tone: "success" },
          ],
        }],
      },
    ],
  };
}

await mkdir(path.join(root, "seed", "mysql"), { recursive: true });
await mkdir(path.join(root, ".stela", "history"), { recursive: true });
await mkdir(path.join(root, "en"), { recursive: true });
await mkdir(path.join(root, "zh"), { recursive: true });
await writeFile(path.join(root, "seed", "mysql", "001_schema.sql"), schema, "utf8");
await writeFile(path.join(root, "seed", "mysql", "002_data.sql"), `${data}\n`, "utf8");
await writeFile(path.join(root, ".stela", "history", "history_demo.jsonl"), history, "utf8");
await writeFile(path.join(root, "en", "business-review.stela.canvas"), `${JSON.stringify(buildCanvas("en"), null, 2)}\n`, "utf8");
await writeFile(path.join(root, "zh", "经营复盘.stela.canvas"), `${JSON.stringify(buildCanvas("zh"), null, 2)}\n`, "utf8");

const summary = Object.fromEntries(results.map((result) => [result.id, result.rows]));
console.log(JSON.stringify({
  counts: {
    customers: fixture.customers.length,
    products: fixture.products.length,
    orders: fixture.orders.length,
    orderItems: fixture.orderItems.length,
    returns: fixture.returns.length,
  },
  results: summary,
}, null, 2));
