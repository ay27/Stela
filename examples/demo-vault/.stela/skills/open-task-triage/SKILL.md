---
name: open-task-triage
description: Triage unexpected open-task growth in the release demo data.
category: analysis-runbook
tags: [demo-tasks, release-health, triage]
---

# Open task triage

When the open-task count rises unexpectedly:

1. Group `demo_tasks` by `source` to identify the entry point creating work.
2. For open tasks, group by `source` and `COALESCE(assignee, 'unassigned')`.
3. Join the affected `release_version` to `release_milestones` before calling
   the release at risk.

For the v0.10 demo, `mobile-onboarding` was released on 2026-07-08. A high
unassigned count from that source needs a product, docs, or QA owner before
the release candidate review.
