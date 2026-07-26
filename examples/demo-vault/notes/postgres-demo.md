---
type: stela-data-note
connection_name: local-postgresql
created_at: "2026-06-28T00:00:00.000Z"
---
# PostgreSQL quick start

Run this block after starting the demo database. The `local-postgresql`
connection is already defined in `.stela/connections.json`. For the full
release investigation, open [[notes/weekly-release-health]].

```runsql
SELECT status, COUNT(*) AS total
FROM demo_tasks
GROUP BY status
ORDER BY status;
```

## Code Inline Completion With AI

```runsql
-- count tasks

```

<br />

## Wiki Link Support

[[notes/mysql-demo]]
