DROP VIEW IF EXISTS order_economics;
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
