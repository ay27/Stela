CREATE TABLE IF NOT EXISTS demo_tasks (
  id INT PRIMARY KEY,
  name VARCHAR(128) NOT NULL,
  status VARCHAR(16) NOT NULL,
  owner VARCHAR(64) NOT NULL
);

INSERT INTO demo_tasks (id, name, status, owner) VALUES
  (1, 'Prepare open-source release', 'open', 'data-team'),
  (2, 'Write connector docs', 'done', 'docs-team'),
  (3, 'Run local smoke test', 'open', 'qa-team')
ON DUPLICATE KEY UPDATE
  name = VALUES(name),
  status = VALUES(status),
  owner = VALUES(owner);
