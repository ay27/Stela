---
type: stela-data-note
connection_name: local-demo
created_at: 2026-04-03 10:00:00
last_modification: 2026-04-03 10:05:00
---

# Stela round-trip sample

This file intentionally uses small fictional data. It exists to verify
frontmatter, RunSQL fences, and `<detail>` blocks can round-trip safely.

```runsql
SELECT 10 AS answer;
```

<detail>
   <block-id>blk_sample_answer</block-id>
   <run-date>2026-04-20 23:21:02</run-date>
   <elapsed>188ms</elapsed>
   <row-count>1</row-count>
   <first-row>{"answer":10}</first-row>
   <result-ref-id>sample-run-answer</result-ref-id>
</detail>

## Example table query

```runsql
SELECT id, name, status
FROM demo_tasks
WHERE status = 'open'
LIMIT 3;
```

<detail>
   <block-id>blk_sample_tasks</block-id>
   <run-date>2026-04-21 10:12:00</run-date>
   <elapsed>42ms</elapsed>
   <row-count>3</row-count>
   <first-row>{"id":1,"name":"Prepare open-source release","status":"open"}</first-row>
   <result-ref-id>sample-run-tasks</result-ref-id>
</detail>

## Example aggregate query

```runsql
SELECT status, COUNT(*) AS total
FROM demo_tasks
GROUP BY status
ORDER BY status;
```

<detail>
   <block-id>blk_sample_summary</block-id>
   <run-date>2026-04-21 10:15:00</run-date>
   <elapsed>37ms</elapsed>
   <row-count>2</row-count>
   <first-row>{"status":"done","total":4}</first-row>
   <result-ref-id>sample-run-summary</result-ref-id>
</detail>
