---
type: stela-data-note
connection_name: local-mysql
created_at: "2026-06-28T00:00:00.000Z"
---
# MySQL Demo

Run this block after starting the demo database. The `local-mysql` connection
is already defined in `.stela/connections.json`.

```runsql
SELECT id, name, status, owner
FROM demo_tasks
ORDER BY id limit 2
```

<detail>
   <block-id>blk_mqxjiktk_l11ttzkm</block-id>
   <run-date>2026-06-28 18:04:34</run-date>
   <elapsed>4ms</elapsed>
   <row-count>2</row-count>
   <first-row>{"id":1,"name":"Prepare open-source release","status":"open","owner":"data-team"}</first-row>
   <result-ref-id>cf982f52-71f8-4aa6-8ced-15e57d61c45f</result-ref-id>
</detail>
