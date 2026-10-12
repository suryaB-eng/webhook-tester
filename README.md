# Webhook tester

A local workspace for testing webhooks.

## Quick start

Requires Node.js 22.14 or newer, npm, and Docker Desktop running Linux containers.
From the repository directory in PowerShell:

```powershell
npm.cmd ci
Copy-Item .env.example .env
docker compose up --build -d --wait
Invoke-RestMethod http://127.0.0.1:4000/health | ConvertTo-Json -Compress
```

The health response is `{"status":"ok"}`. Open http://127.0.0.1:4173.
The shell shows an empty scenario list and checks the API through `/api/health`.
Use **Check again** to refresh the connection status.

Web, API, and PostgreSQL host ports bind to `127.0.0.1` at 4173, 4000,
and 55432 respectively. Local database credentials are disposable; connection
URLs are in `.env.example`. The initialization SQL creates `webhook_tester`
and `demo_target` with separate owners and no application tables.

```powershell
docker compose ps
docker compose exec postgres psql -U postgres -d postgres -c "SELECT datname, pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname IN ('webhook_tester', 'demo_target');"
```

Database initialization runs only on a fresh named volume. The volume persists
when services stop. Changing `.env` does not update passwords in an existing
database. The application and demo owner passwords are defined in the
initialization SQL; `POSTGRES_PASSWORD` configures the local administrator.
Stop services with `docker compose down`.

## Project status

**Working now**

- React web shell with navigation and an empty scenario state.
- Fastify `GET /health` and a real API connection check in the web shell.
- Local PostgreSQL with separate application and demo databases.

**Next up**

- Scenario authoring and persistence.
- Webhook execution in a separate worker.

These next features are intended and are not implemented.

## Development

Start the API and web server in separate terminals:

```powershell
npm.cmd run dev:api
npm.cmd run dev:web
```

For a database alongside native development, use `docker compose up -d --wait postgres`.
Native scripts default to the loopback addresses above. They do not load the root
`.env`; set `$env:API_HOST`, `$env:API_PORT`, or `$env:API_PROXY_TARGET` in
PowerShell if you need an override. Compose uses its internal service addresses.

```powershell
npm.cmd run lint
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
```

Tests exercise the API over HTTP and health-response validation against a real
HTTP server, including error responses. For a browser check, confirm **Connected**,
stop the API, press **Check again** and confirm **Unavailable**, then restart the
API and retry. Also check the empty state at a narrow browser width.

`npm.cmd` avoids PowerShell execution-policy restrictions on `npm.ps1`.
The only workspaces are `apps/api` and `apps/web`.
See [architecture](docs/architecture.md) for their current boundaries.

Package versions and configuration choices were adapted from
`suryaB-eng/webhook-lab` at `e6a761182bd338f68dd439e260bb25b3d91bb44c`.
The reference application's implementation and Git history were not imported.
Its MIT license notice is preserved in [LICENSE](LICENSE).
