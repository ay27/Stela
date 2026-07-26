---
type: stela-data-note
connection_name: local-mysql
created_at: "2026-06-28T00:00:00.000Z"
---
# MySQL quick start

Run this block after starting the demo database. The `local-mysql` connection
is already defined in `.stela/connections.json`. This query uses the same
fixture data as [[notes/weekly-release-health]].

```runsql
SELECT
  source,
  COUNT(*) AS total_tasks,
  SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_tasks
FROM demo_tasks
GROUP BY source
ORDER BY open_tasks DESC, total_tasks DESC;
```
