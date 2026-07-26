---
name: unassigned-tasks-definition
description: "Business definition of 'unassigned tasks' in the stela_demo.demo_tasks table used by the release-health analysis."
category: business-glossary
tags: [demo-tasks, assignee, unassigned, release-health, mobile-onboarding]
---

# Unassigned Tasks — Business Definition

**Table:** `stela_demo.demo_tasks`

**Definition:** A task is considered **unassigned** when the `assignee` column is `NULL`. This is distinct from having a named person set as the assignee (e.g., `'nora'`, `'aya'`, `'sam'`).

**Rationale from vault notes:**
- In `notes/weekly-release-health.md`, unassigned status is computed as `COALESCE(assignee, 'unassigned')`, confirming that `NULL` assignee means unassigned.
- The `owner` column (team name like `product-team`, `docs-team`) is a separate concept — a task can have an owner team but no individual assignee.

**Recommended SQL pattern:**
```sql
WHERE assignee IS NULL
```

Or, for display:
```sql
COALESCE(assignee, 'unassigned') AS assignee
```

**Related columns:**
- `owner` — team responsible for the task (e.g., `product-team`, `qa-team`)
- `status` — task state (`open`, `done`, etc.)
- `source` — origin of the task (e.g., `mobile-onboarding`, `web`)

**Known use case:** In the weekly release health review, unassigned mobile-onboarding tasks are grouped by `owner` to identify which teams still need to assign someone to their open tasks before a release candidate review.
