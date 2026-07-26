CREATE TABLE IF NOT EXISTS demo_tasks (
  id INT PRIMARY KEY,
  name VARCHAR(128) NOT NULL,
  status VARCHAR(16) NOT NULL,
  owner VARCHAR(64) NOT NULL,
  assignee VARCHAR(64),
  source VARCHAR(64) NOT NULL,
  release_version VARCHAR(16) NOT NULL,
  created_at DATE NOT NULL
);

CREATE TABLE IF NOT EXISTS task_events (
  id INT PRIMARY KEY,
  task_id INT NOT NULL,
  event_type VARCHAR(32) NOT NULL,
  occurred_at DATETIME NOT NULL,
  actor VARCHAR(64) NOT NULL,
  detail VARCHAR(255) NOT NULL,
  CONSTRAINT fk_task_events_task FOREIGN KEY (task_id) REFERENCES demo_tasks(id)
);

CREATE TABLE IF NOT EXISTS release_milestones (
  id INT PRIMARY KEY,
  version VARCHAR(16) NOT NULL,
  name VARCHAR(128) NOT NULL,
  target_date DATE NOT NULL,
  owner VARCHAR(64) NOT NULL,
  status VARCHAR(16) NOT NULL
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
ON DUPLICATE KEY UPDATE
  name = VALUES(name),
  status = VALUES(status),
  owner = VALUES(owner),
  assignee = VALUES(assignee),
  source = VALUES(source),
  release_version = VALUES(release_version),
  created_at = VALUES(created_at);

INSERT INTO task_events (id, task_id, event_type, occurred_at, actor, detail) VALUES
  (1, 9, 'created', '2026-07-08 09:12:00', 'mobile-feedback-bot', 'Submitted from the mobile onboarding flow.'),
  (2, 10, 'created', '2026-07-08 09:28:00', 'mobile-feedback-bot', 'Submitted from the mobile onboarding flow.'),
  (3, 11, 'created', '2026-07-08 10:04:00', 'mobile-feedback-bot', 'Submitted from the mobile onboarding flow.'),
  (4, 16, 'assigned', '2026-07-09 14:20:00', 'maya', 'Assigned to QA after initial triage.'),
  (5, 20, 'assigned', '2026-07-10 11:07:00', 'aya', 'Assigned to product for copy review.'),
  (6, 22, 'completed', '2026-07-11 16:31:00', 'nora', 'Resolved shortcut conflict before release review.')
ON DUPLICATE KEY UPDATE
  task_id = VALUES(task_id),
  event_type = VALUES(event_type),
  occurred_at = VALUES(occurred_at),
  actor = VALUES(actor),
  detail = VALUES(detail);

INSERT INTO release_milestones (id, version, name, target_date, owner, status) VALUES
  (1, 'v0.10', 'Mobile onboarding rollout', '2026-07-08', 'maya', 'released'),
  (2, 'v0.10', 'Release candidate review', '2026-07-15', 'maya', 'at-risk'),
  (3, 'v0.11', 'Backlog planning', '2026-07-22', 'aya', 'planned')
ON DUPLICATE KEY UPDATE
  version = VALUES(version),
  name = VALUES(name),
  target_date = VALUES(target_date),
  owner = VALUES(owner),
  status = VALUES(status);
