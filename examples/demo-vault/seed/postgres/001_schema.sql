CREATE TABLE IF NOT EXISTS demo_tasks (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  owner TEXT NOT NULL,
  assignee TEXT,
  source TEXT NOT NULL,
  release_version TEXT NOT NULL,
  created_at DATE NOT NULL
);

CREATE TABLE IF NOT EXISTS task_events (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES demo_tasks(id),
  event_type TEXT NOT NULL,
  occurred_at TIMESTAMP NOT NULL,
  actor TEXT NOT NULL,
  detail TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS release_milestones (
  id INTEGER PRIMARY KEY,
  version TEXT NOT NULL,
  name TEXT NOT NULL,
  target_date DATE NOT NULL,
  owner TEXT NOT NULL,
  status TEXT NOT NULL
);

INSERT INTO demo_tasks (id, name, status, owner, assignee, source, release_version, created_at) VALUES
  (1, 'Prepare open-source release', 'open', 'data-team', 'maya', 'web', 'v0.10', '2026-06-24'),
  (2, 'Write connector docs', 'done', 'docs-team', 'leo', 'web', 'v0.10', '2026-06-25'),
  (3, 'Run local smoke test', 'open', 'qa-team', 'nora', 'web', 'v0.10', '2026-06-26'),
  (4, 'Review release notes', 'done', 'docs-team', 'leo', 'web', 'v0.10', '2026-06-30'),
  (5, 'Verify upgrade path', 'done', 'qa-team', 'nora', 'web', 'v0.10', '2026-07-01'),
  (6, 'Publish changelog draft', 'open', 'docs-team', 'leo', 'web', 'v0.10', '2026-07-02'),
  (7, 'Triage signup feedback', 'done', 'product-team', 'aya', 'web', 'v0.10', '2026-07-03'),
  (8, 'Check onboarding funnel copy', 'done', 'product-team', 'aya', 'web', 'v0.10', '2026-07-04'),
  (9, 'Mobile onboarding: missing workspace name', 'open', 'product-team', NULL, 'mobile-onboarding', 'v0.10', '2026-07-08'),
  (10, 'Mobile onboarding: connection form validation', 'open', 'product-team', NULL, 'mobile-onboarding', 'v0.10', '2026-07-08'),
  (11, 'Mobile onboarding: empty vault guidance', 'open', 'product-team', NULL, 'mobile-onboarding', 'v0.10', '2026-07-08'),
  (12, 'Mobile onboarding: retry after timeout', 'open', 'qa-team', NULL, 'mobile-onboarding', 'v0.10', '2026-07-08'),
  (13, 'Mobile onboarding: connection picker contrast', 'open', 'design-team', NULL, 'mobile-onboarding', 'v0.10', '2026-07-08'),
  (14, 'Mobile onboarding: default database selection', 'open', 'product-team', NULL, 'mobile-onboarding', 'v0.10', '2026-07-09'),
  (15, 'Mobile onboarding: import shortcut copy', 'open', 'docs-team', NULL, 'mobile-onboarding', 'v0.10', '2026-07-09'),
  (16, 'Mobile onboarding: Windows path handling', 'open', 'qa-team', 'nora', 'mobile-onboarding', 'v0.10', '2026-07-09'),
  (17, 'Mobile onboarding: schema refresh feedback', 'open', 'data-team', NULL, 'mobile-onboarding', 'v0.10', '2026-07-09'),
  (18, 'Mobile onboarding: credential help link', 'open', 'docs-team', NULL, 'mobile-onboarding', 'v0.10', '2026-07-10'),
  (19, 'Mobile onboarding: unsupported driver message', 'open', 'data-team', NULL, 'mobile-onboarding', 'v0.10', '2026-07-10'),
  (20, 'Mobile onboarding: improve first query example', 'open', 'product-team', 'aya', 'mobile-onboarding', 'v0.10', '2026-07-10'),
  (21, 'Mobile onboarding: confirm telemetry wording', 'open', 'legal-team', NULL, 'mobile-onboarding', 'v0.10', '2026-07-11'),
  (22, 'Mobile onboarding: macOS shortcut conflict', 'done', 'qa-team', 'nora', 'mobile-onboarding', 'v0.10', '2026-07-11'),
  (23, 'Review v0.10 release checklist', 'open', 'release-team', 'maya', 'web', 'v0.10', '2026-07-11'),
  (24, 'Prepare v0.11 backlog', 'open', 'product-team', 'aya', 'web', 'v0.11', '2026-07-12'),
  (25, 'Mobile onboarding: keyboard focus order', 'open', 'design-team', NULL, 'mobile-onboarding', 'v0.10', '2026-07-12'),
  (26, 'Mobile onboarding: workspace name examples', 'open', 'docs-team', NULL, 'mobile-onboarding', 'v0.10', '2026-07-12'),
  (27, 'Mobile onboarding: failed connection recovery', 'open', 'data-team', NULL, 'mobile-onboarding', 'v0.10', '2026-07-12'),
  (28, 'Mobile onboarding: screen reader labels', 'open', 'design-team', 'sam', 'mobile-onboarding', 'v0.10', '2026-07-13'),
  (29, 'Mobile onboarding: sample vault download', 'open', 'product-team', NULL, 'mobile-onboarding', 'v0.10', '2026-07-13'),
  (30, 'Mobile onboarding: confirm connection success', 'done', 'qa-team', 'nora', 'mobile-onboarding', 'v0.10', '2026-07-13'),
  (31, 'Audit release blocker labels', 'open', 'release-team', 'maya', 'web', 'v0.10', '2026-07-13'),
  (32, 'Draft v0.11 discovery brief', 'open', 'product-team', 'aya', 'web', 'v0.11', '2026-07-14')
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  status = EXCLUDED.status,
  owner = EXCLUDED.owner,
  assignee = EXCLUDED.assignee,
  source = EXCLUDED.source,
  release_version = EXCLUDED.release_version,
  created_at = EXCLUDED.created_at;

INSERT INTO task_events (id, task_id, event_type, occurred_at, actor, detail) VALUES
  (1, 9, 'created', '2026-07-08 09:12:00', 'mobile-feedback-bot', 'Submitted from the mobile onboarding flow.'),
  (2, 10, 'created', '2026-07-08 09:28:00', 'mobile-feedback-bot', 'Submitted from the mobile onboarding flow.'),
  (3, 11, 'created', '2026-07-08 10:04:00', 'mobile-feedback-bot', 'Submitted from the mobile onboarding flow.'),
  (4, 16, 'assigned', '2026-07-09 14:20:00', 'maya', 'Assigned to QA after initial triage.'),
  (5, 20, 'assigned', '2026-07-10 11:07:00', 'aya', 'Assigned to product for copy review.'),
  (6, 22, 'completed', '2026-07-11 16:31:00', 'nora', 'Resolved shortcut conflict before release review.')
ON CONFLICT (id) DO UPDATE SET
  task_id = EXCLUDED.task_id,
  event_type = EXCLUDED.event_type,
  occurred_at = EXCLUDED.occurred_at,
  actor = EXCLUDED.actor,
  detail = EXCLUDED.detail;

INSERT INTO release_milestones (id, version, name, target_date, owner, status) VALUES
  (1, 'v0.10', 'Mobile onboarding rollout', '2026-07-08', 'maya', 'released'),
  (2, 'v0.10', 'Release candidate review', '2026-07-15', 'maya', 'at-risk'),
  (3, 'v0.11', 'Backlog planning', '2026-07-22', 'aya', 'planned')
ON CONFLICT (id) DO UPDATE SET
  version = EXCLUDED.version,
  name = EXCLUDED.name,
  target_date = EXCLUDED.target_date,
  owner = EXCLUDED.owner,
  status = EXCLUDED.status;
