# Webhook tester

A local workspace for testing payment and order-status webhooks.

## Quick start

Requires Node.js 22.14 or newer, npm, and Docker Desktop running Linux containers.
From the repository directory in PowerShell:

```powershell
npm.cmd ci
Copy-Item .env.example .env
docker compose up --build -d --wait
Invoke-RestMethod http://127.0.0.1:4000/health
```

Open http://127.0.0.1:4173. Choose a scenario and either
**Without deduplication** or **With deduplication**. The run page reads saved
results and survives refresh. Select a delivery to inspect its payload, response,
and timings.

Web, API, demo target, and PostgreSQL bind to host loopback on ports
4173, 4000, 4010, and 55432. The worker publishes no port.
Local credentials in `.env.example` are disposable. Compose migrates existing
local volumes before services start; changing `.env` does not change existing
database passwords. Stop services with `docker compose down`.

## Project status

**Working now**

- Four saved presets: One payment, Sequential duplicate payment, Concurrent
  duplicate payment, and Status version 2 before version 1. Restarting the API
  inserts missing presets without replacing saved edits.
- Validated scenarios, server-selected profiles, and queued runs with immutable
  scenario and public target snapshots.
- A separate worker with PostgreSQL ownership, sequential and bounded concurrent
  delivery, bounded responses, timeouts, and SELECT-only scalar assertions.
- Saved request/response details, timestamps, assertion expectations/results,
  and run status, shown through real API polling.
- Run-scoped fixtures, transactional payment handling, and version-guarded status
  updates. Corrected handling deduplicates payments and ignores stale/equal versions.

One payment passes both profiles at fulfillment 1 / inventory 9. Sequential and
concurrent duplicates return HTTP 200 twice: Without deduplication fails at 2/8;
With deduplication passes at 1/9. Sending status version 2 (shipped) before version 1
(processing) leaves processing/version 1 on the flawed profile and shipped/version 2
on the corrected profile.

Normal completion saves results before removing that run's fixtures.
Transport timeouts, ownership loss, and failed result writes retain run-scoped
fixtures so uncertain work and unsaved observations remain inspectable.
Abandoned runs become interrupted and are never automatically replayed. Cleanup failure is an error.

**Next up**

- Scenario authoring.

Scenario authoring is intended and is not implemented.

## Development

For native development, start PostgreSQL and apply migrations:

```powershell
docker compose up -d --wait postgres
npm.cmd run migrate
npm.cmd run build:shared
npm.cmd run dev:api
# In separate terminals:
npm.cmd run dev:demo
npm.cmd run dev:worker
npm.cmd run dev:web
```

Stop the Compose worker before running a native or test-owned worker.
API, demo, migration, and worker commands load the root `.env` if present.
`LOCAL_ORIGIN` must match the browser origin (default `http://127.0.0.1:4173`);
mutation requests require that Origin header and JSON. Target endpoints come
from server configuration, never browser input.

Tests use a separate PostgreSQL instance on loopback 55433 with disposable
container storage and a dedicated database marker. They do not use the normal
application database URLs.

```powershell
docker compose stop worker
docker compose -f compose.test.yaml up -d --wait
npm.cmd run lint
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
docker compose -f compose.test.yaml down
docker compose start worker
```

For a concurrent duplicate-payment API check:

```powershell
$headers = @{ Origin = "http://127.0.0.1:4173" }
$body = @{ scenarioId = "concurrent-duplicate-payment"; targetId = "demo-flawed" } | ConvertTo-Json
$queued = Invoke-RestMethod http://127.0.0.1:4000/api/runs -Method Post -Headers $headers -ContentType "application/json" -Body $body
$deadline = (Get-Date).AddSeconds(60)
do {
    Start-Sleep -Milliseconds 250
    $run = Invoke-RestMethod "http://127.0.0.1:4000/api/runs/$($queued.runId)"
    if ((Get-Date) -gt $deadline) { throw "Run has not completed; inspect the worker logs." }
} while ($run.status -in @("queued", "running"))
$run | ConvertTo-Json -Depth 20
```

Expect `failed`, delivery statuses 200/200, and assertion actuals 2 and 8.
Use `demo-corrected` for `passed`, 200/200, and actuals 1 and 9.
The same GET URL always reads that saved run; it does not launch another run.

`npm.cmd` avoids PowerShell restrictions on `npm.ps1`.
See [architecture](docs/architecture.md) for service boundaries.

Dependency/configuration choices, validation, transaction, enqueue/snapshot,
scalar assertion, delivery scheduling, and bounded response patterns were adapted
from relevant modules of `suryaB-eng/webhook-lab` at
`e6a761182bd338f68dd439e260bb25b3d91bb44c`. Its Git history was not imported.
The reference MIT notice is preserved in [LICENSE](LICENSE).
