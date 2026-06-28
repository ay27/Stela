# Stela Demo Vault

This vault is safe to publish. It contains only fictional data and local demo
connection templates.

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
3. Open `notes/mysql-demo.md` or `notes/postgres-demo.md` and run the SQL blocks.
4. Open `notes/markdown-syntax-showcase.md` to review common Markdown syntax rendering.

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
