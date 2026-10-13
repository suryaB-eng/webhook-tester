# Webhook tester

A local workspace for testing payment and order-status webhooks.

## Quick start

Requires Node.js 22.14 or newer, npm, and Docker Desktop running Linux containers.
From the repository directory in PowerShell:

```powershell
npm.cmd ci
if (!(Test-Path .env)) { Copy-Item .env.example .env }
docker compose up --build -d --wait
Invoke-RestMethod http://127.0.0.1:4000/health
```

Open http://127.0.0.1:4173. Choose a scenario and either **Without deduplication**
or **With deduplication**. Select a delivery to inspect its payload, response,
and timings. The run page streams saved progress and survives refresh.
Run history lists saved results; select two to compare, or open a completed run
and use **Rerun with**. Scenario drafts stay local until Save; revision conflicts
preserve your draft.

Web, API, demo target, and PostgreSQL bind to host loopback on ports
4173, 4000, 4010, and 55432. The worker publishes no port. Credentials in
`.env.example` are disposable. Compose migrates existing volumes before services
start; changing `.env` does not change existing database passwords.
Stop services with `docker compose down`.

## Project status

**Working now**

- Four saved presets: One payment, Sequential duplicate payment, Concurrent
  duplicate payment, and Status version 2 before version 1. Seeds preserve edits.
- Scenario creation, revision-checked editing, duplication, and strict JSON
  import/export, with field errors and a 1 MiB UTF-8 import limit.
- Queued runs with validated scenario snapshots and sanitized public targets.
- A separate worker with PostgreSQL ownership, sequential and bounded concurrent
  delivery, bounded responses, timeouts, and SELECT-only scalar assertions.
- Saved request/response details, assertions, timestamps, status, and live event
  replay. Abandoned runs are interrupted without automatic replay.
- Bounded history, reruns from terminal runs' frozen snapshots, and comparison
  by delivery/assertion ID, including changed settings and missing evidence.
- Run-scoped fixtures, transactional payment deduplication, and status updates
  that preserve newer versions on the corrected profile.

One payment passes both profiles at fulfillment 1 / inventory 9. Duplicate
payments return HTTP 200 twice: Without deduplication fails at 2/8; With
deduplication passes at 1/9. Status version 2 (shipped) followed by version 1
(processing) leaves processing/version 1 on the flawed profile and shipped/version 2
on the corrected profile. Results are saved before normal fixture cleanup.
Uncertain HTTP work retains fixtures; aborting HTTP does not prove target work stopped.

**Next up**

- Further improvements will be scoped separately.

## Development

For native development:

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

Stop the Compose worker before a native or test-owned worker runs. Commands load
root `.env` if present. `LOCAL_ORIGIN` must match the browser origin
(default `http://127.0.0.1:4173`); mutations require that Origin and JSON.
Endpoints come from server configuration.

Tests use separate disposable PostgreSQL on loopback 55433 and verify its
marker before mutations; they do not use normal application database URLs.

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

For a history check, run Sequential duplicate payment with Without deduplication.
Expect failed, two HTTP 200 responses, and actuals 2/8. Choose With deduplication
under Rerun with; expect passed and actuals 1/9. In Run history, select both and
Compare runs. Refresh the comparison and each run URL: results and the rerun
relationship remain. Editing the source scenario never changes the saved runs
or the snapshot used by a later rerun.

`npm.cmd` avoids PowerShell restrictions on `npm.ps1`.
See [architecture](docs/architecture.md) for service boundaries.

Dependency/configuration choices and relevant validation, transaction, scheduling,
editor, snapshot rerun, comparison, streaming, and bounded response patterns were
adapted from individual modules of `suryaB-eng/webhook-lab` at
`e6a761182bd338f68dd439e260bb25b3d91bb44c`. Its Git history was not imported.
The reference MIT notice is preserved in [LICENSE](LICENSE).
