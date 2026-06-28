---
type: stela-data-note
connection_name: local-mysql
created_at: "2026-06-28T00:00:00.000Z"
---
# MySQL Demo

Run this block after starting the demo database. The `local-mysql` connection
is already defined in `.stela/connections.json`.

```runsql
SELECT COUNT(*) AS total_count
FROM stela_demo.demo_tasks;
```

<detail>
   <block-id>blk_mqxjiktk_l11ttzkm</block-id>
   <run-date>2026-06-28 22:29:18</run-date>
   <elapsed>13ms</elapsed>
   <row-count>2</row-count>
   <first-row>{"status":"done","count":"1"}</first-row>
   <result-ref-id>5f63a2e6-808d-45f9-9fd6-de730b550399</result-ref-id>
</detail>
