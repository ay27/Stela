---
connection_name: local-mysql
---

# Stela Demo Vault

This vault is safe to publish. It contains only fictional release-operations
data and local demo connection templates.

## Start Demo Databases

```bash
cd examples/demo-vault
docker compose up -d
```

The containers expose:

- MySQL: `127.0.0.1:3306`, database `stela_demo`, user `demo`, password `demo`
- PostgreSQL: `127.0.0.1:5432`, database `stela_demo`, user `demo`, password `demo`

## Use in Stela

1. Open this folder as a vault.
2. Open Settings -> Connector Plugins and confirm MySQL/PostgreSQL are installed.
3. Open `notes/weekly-release-health.md` and run its SQL blocks. It explains
   the v0.10 mobile-onboarding task spike using the seeded release data.
4. Open `notes/mobile-rollout-context.md` for the business context that an
   Agent can search while investigating the spike.
5. Open `notes/mysql-demo.md` or `notes/postgres-demo.md` for shorter
   connection-specific examples.
6. Open `notes/markdown-syntax-showcase.md` to review common Markdown syntax rendering.

## Product Hunt screenshots

This vault is the source for real Stela screenshots:

1. Show `weekly-release-health.md` with executed RunSQL results, an unfinished
   follow-up query, and the Agent sidebar.
2. Ask the Agent: `Why did open tasks rise after the rollout? Cite SQL evidence.`
3. Open **Experience Knowledge** from the bottom dock to show the
   `open-task-triage` runbook in `.stela/skills/`.
4. Open Settings -> Connections and Settings -> Connector Plugins to show the
   two local fixtures and installed connectors.

The included AI settings are deliberately disabled and contain no key. Configure
your own provider locally before taking Agent screenshots; do not commit the
resulting credential files.

This vault includes `.stela/connections.json` with local-only demo credentials
(`demo` / `demo`). They are public Docker fixture credentials, not production
secrets. When Stela loads the vault, it may migrate password fields into the
local `.stela/secrets/` shard.

## Docker Troubleshooting

If `docker compose up -d` fails with:

```text
failed to connect to the docker API at unix:///var/run/docker.sock
```

Docker is installed but the Docker daemon is not running. Start Docker Desktop,
wait until it says Docker is running, then run the command again.
