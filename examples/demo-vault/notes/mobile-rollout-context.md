---
type: stela-data-note
created_at: "2026-07-08T08:30:00.000Z"
---

# Mobile onboarding rollout context

## What changed

v0.10 enabled the mobile onboarding flow on July 8. The flow lets new users
create a local vault, choose a connector, and run their first query without
leaving the onboarding sequence.

## Expected support pattern

The launch team expected a small rise in copy and connection questions during
the first week. New feedback is created with `source = 'mobile-onboarding'`.
Product triage should assign an owner within one business day.

## Release risk

The release candidate review is blocked if onboarding tasks remain unassigned,
or if connection recovery failures affect multiple platforms.

Related analysis: [[notes/weekly-release-health]]
