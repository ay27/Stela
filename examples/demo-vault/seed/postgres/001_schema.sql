CREATE TABLE IF NOT EXISTS demo_tasks (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  owner TEXT NOT NULL
);

INSERT INTO demo_tasks (id, name, status, owner) VALUES
  (1, 'Prepare open-source release', 'open', 'data-team'),
  (2, 'Write connector docs', 'done', 'docs-team'),
  (3, 'Run local smoke test', 'open', 'qa-team')
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  status = EXCLUDED.status,
  owner = EXCLUDED.owner;
