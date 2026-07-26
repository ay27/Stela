---
type: stela-data-note
connection_name: local-mysql
created_at: "2026-07-14T09:00:00.000Z"
---
# Weekly release health

The v0.10 mobile onboarding rollout shipped on July 8. Open tasks rose sharply
after launch, so this review separates the increase by source and assignment
state before the release candidate review.

## 1. Is the increase isolated to one source?

```runsql
SELECT
  source,
  COUNT(*) AS total_tasks,
  SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_tasks
FROM demo_tasks
GROUP BY source
ORDER BY open_tasks DESC, total_tasks DESC;
```

<detail>
   <block-id>blk_ms1c28zj_jn4nm26n</block-id>
   <run-date>2026-07-26 13:04:42</run-date>
   <elapsed>7ms</elapsed>
   <row-count>2</row-count>
   <first-row>{"source":"mobile-onboarding","total_tasks":"20","open_tasks":"18"}</first-row>
   <result-ref-id>c3ba32bb-3007-4d9a-9f3b-4bbc4c202615</result-ref-id>
</detail>

## 2. Who still needs a triage decision?

```runsql
SELECT
  source,
  COALESCE(assignee, 'unassigned') AS assignee,
  COUNT(*) AS open_tasks
FROM demo_tasks
WHERE status = 'open'
GROUP BY source, COALESCE(assignee, 'unassigned')
ORDER BY open_tasks DESC, assignee;
```

<detail>
   <block-id>blk_ms1c366p_icnqozc2</block-id>
   <run-date>2026-07-26 13:04:47</run-date>
   <elapsed>3ms</elapsed>
   <row-count>8</row-count>
   <first-row>{"source":"mobile-onboarding","assignee":"unassigned","open_tasks":"15"}</first-row>
   <result-ref-id>82ba72be-0eff-484d-ae38-84055c415a2e</result-ref-id>
</detail>

## 3. Does the spike put a release milestone at risk?

```runsql
SELECT
  m.version,
  m.name AS milestone,
  m.target_date,
  m.status AS milestone_status,
  SUM(CASE WHEN t.status = 'open' THEN 1 ELSE 0 END) AS open_tasks
FROM release_milestones AS m
LEFT JOIN demo_tasks AS t ON t.release_version = m.version
GROUP BY m.version, m.name, m.target_date, m.status
ORDER BY m.target_date;
```

<detail>
   <block-id>blk_ms1c398m_3oktur64</block-id>
   <run-date>2026-07-26 13:04:49</run-date>
   <elapsed>5ms</elapsed>
   <row-count>3</row-count>
   <first-row>{"version":"v0.10","milestone":"Mobile onboarding rollout","target_date":"2026-07-07T16:00:00Z","milestone_status":"released","open_tasks":"23"}</first-row>
   <result-ref-id>330d05a4-59ef-484c-9ea0-be403ce1f4ed</result-ref-id>
</detail>

## Working conclusion

Most new work came from `mobile-onboarding`, and most of those tasks are still
unassigned. The release candidate review is at risk until product, docs, and
QA have owners for the onboarding queue.

## 4. Comprehensive `demo_tasks` table analysis

**Table:** `stela_demo.demo_tasks` (32 rows)

**Columns:**

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | int | NO | — | Primary key |
| `name` | varchar(128) | NO | — | Task description |
| `status` | varchar(16) | NO | — | `open` (25 / 78%) or `done` (7 / 22%) |
| `owner` | varchar(64) | NO | — | Team responsible (e.g. `product-team`, `docs-team`) |
| `assignee` | varchar(64) | YES | NULL | Individual assignee; `NULL` = unassigned |
| `source` | varchar(64) | NO | `web` | Origin system: `mobile-onboarding` (20) or `web` (12) |
| `release_version` | varchar(16) | NO | `v0.10` | Milestone version: `v0.10` (30) or `v0.11` (2) |
| `created_at` | date | NO | `2026-06-24` | Task creation date |

**Status distribution:** Open = 25 (78.1%), Done = 7 (21.9%).

**By source:**

| Source | Total | Open | Unassigned & Open | Unassigned % of open |
|---|---|---|---|---|
| `mobile-onboarding` | 20 | 18 | 15 | 83.3% |
| `web` | 12 | 7 | 0 | 0.0% |

**Unassigned open tasks by owner team (mobile-onboarding source):**

| Owner Team | Unassigned Open Tasks |
|---|---|
| `product-team` | 5 |
| `data-team` | 3 |
| `docs-team` | 3 |
| `design-team` | 2 |
| `qa-team` | 1 |
| `legal-team` | 1 |

**Timeline:** Mobile-onboarding tasks started appearing on July 8 (launch day), with 5 tasks created on Jul 7–8, tapering to 2–4 per day through Jul 12. Web tasks were created steadily from Jun 24 through Jul 3 (pre-launch) and then scattered Jul 10–13.

**Assignment gap:** Of 18 open mobile-onboarding tasks, only 3 have an assignee (nora, aya, sam). The remaining 15 are unassigned — 83% of the mobile-onboarding open queue.

**Milestone impact via `release_milestones`:** The `v0.10` release candidate review (target Jul 15, status `at-risk`) has 23 open tasks tied to it — 77% of all open tasks in the system. Most of these are from mobile-onboarding and lack an individual assignee.

## Next question

```runsql
SELECT
  COALESCE(owner, 'no-owner') AS owner,
  COUNT(*) AS unassigned_tasks
FROM stela_demo.demo_tasks
WHERE source = 'mobile-onboarding'
  AND assignee IS NULL
GROUP BY owner
ORDER BY unassigned_tasks DESC, owner;
```

See \[\[notes/mobile-rollout-context]] for the rollout timeline and
\[\[notes/mysql-demo]] for the same task data through MySQL.
