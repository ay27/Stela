import assert from "node:assert/strict";

import { extractSqlSymbols } from "./sql-symbols";

const symbols = extractSqlSymbols(`
with recent_orders as (
  select user_id, amount from mart.orders where created_at > now() - interval '7 days'
)
select u.id, u.email, sum(r.amount) as revenue
from dim.users as u
join recent_orders r on r.user_id = u.id
group by u.id, u.email
limit 100
`);

assert.deepEqual(symbols.tables, ["mart.orders", "dim.users", "recent_orders"]);
assert.equal(symbols.aliases.u, "dim.users");
assert.equal(symbols.aliases.r, "recent_orders");
assert.deepEqual(symbols.ctes, ["recent_orders"]);
assert.ok(symbols.referencedColumns.includes("email"));
assert.ok(symbols.dialectHints.includes("limit"));

console.log("ai sql-symbols tests passed.");

