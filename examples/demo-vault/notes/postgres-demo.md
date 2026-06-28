---
type: stela-data-note
connection_name: local-postgresql
created_at: "2026-06-28T00:00:00.000Z"
---
# PostgreSQL Demo

Run this block after starting the demo database. The `local-postgresql`
connection is already defined in `.stela/connections.json`.

```runsql
SELECT status, COUNT(*) AS total
FROM demo_tasks
GROUP BY status
ORDER BY status;
```

<detail>
   <block-id>blk_mqxjigwm_yygucvsq</block-id>
   <run-date>2026-06-28 16:41:50</run-date>
   <elapsed>8ms</elapsed>
   <row-count>2</row-count>
   <first-row>{"status":"done","total":"1"}</first-row>
   <result-ref-id>753f14d2-4716-444f-9579-02079645ebfa</result-ref-id>
</detail>

<br />

## SQL Autocomplete

```runsql
SELECT * FROM de
```

<br />

## Wiki Link Support

\[\[notes/mysql-demo]]
