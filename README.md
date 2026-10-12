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
Invoke-RestMethod http://127.0.0.1:4010/health | ConvertTo-Json -Compress
```

Both health responses are `{"status":"ok"}`. Open http://127.0.0.1:4173.
The shell shows an empty scenario list and checks the real API connection.

Web, API, demo target, and PostgreSQL host ports bind to `127.0.0.1` at
4173, 4000, 4010, and 55432. Local credentials in `.env.example` are disposable.
Compose applies migrations before starting dependent services. Existing local
volumes are upgraded without deleting data. Database initialization runs only
on a fresh volume; changing `.env` does not change existing passwords.
Stop services with `docker compose down`.

## Project status

**Working now**

- React web shell, empty scenario state, and Fastify API health endpoint.
- Shared `ScenarioV1` validation with sequential steps, unique configuration IDs,
  checked event references, scalar assertion expectations, and bounded limits/imports.
- Payment demo profiles at `POST /webhooks/flawed` and `POST /webhooks/corrected`.
- Run-scoped payment fixtures, transactional effects, and separate application,
  fixture, and SELECT-only assertion database logins.

The flawed profile repeats effects for every delivery. The corrected profile
deduplicates by the payment's business-event `id` and guards the unpaid-to-paid
transition. Its claim, stock decrement, and fulfillment commit together.
Failed effects roll everything back. Transport delivery IDs do not deduplicate.

Only `demo-flawed` and `demo-corrected` scenarios are supported by demo validation.
Payloads are `{id, type:"payment.succeeded", data:{orderId, quantity}}`, with integer
quantity 1–10. Order IDs can vary; a shared order must have a consistent quantity.
Conflicting payloads for a shared business-event ID are rejected.
Limits are 100 total deliveries, concurrency 1–10, delay 0–5000 ms, request timeout
100–10000 ms, run timeout 1000–60000 ms, and 1 MiB bodies/imports.
Concurrent step mode is rejected. Assertions are validated, not executed yet.

**Next up**

- Scenario authoring and persistence.
- Webhook execution in a separate worker.

These next features are intended and are not implemented.

## Development

```powershell
npm.cmd run build:shared
npm.cmd run migrate
npm.cmd run dev:api
# In separate terminals:
npm.cmd run dev:web
npm.cmd run dev:demo
```

For native development, start PostgreSQL with `docker compose up -d --wait postgres`.
Migration and demo commands load the root `.env` if present. API/web commands
use their existing defaults; set their environment overrides in PowerShell.
The current API still does not access the application database.

Tests use a separate PostgreSQL instance on loopback port 55433, stored in
disposable container memory. They check its dedicated database marker before
mutations and clean only generated run IDs.

```powershell
docker compose -f compose.test.yaml up -d --wait
npm.cmd run lint
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
docker compose -f compose.test.yaml down
```

Tests cover contract rejection, migration repeatability, role privileges,
payment effects and rollback, changed transport IDs, and fixture isolation.
Shared exports build before tests and typechecking.

For an API check after building, this PowerShell example prepares a fresh run,
sends the same payment twice to the corrected service, reads effects, and cleans up:

```powershell
@'
import { randomUUID } from 'node:crypto';
import { createPool, databaseUrls, prepareDemoFixtures, cleanupDemoFixtures } from '@webhook-tester/db';
const urls = databaseUrls();
const fixture = createPool(urls.targetFixture);
const query = createPool(urls.targetQuery);
const runId = randomUUID();
try {
  await prepareDemoFixtures(fixture, runId, [{ orderId: 'order_example', quantity: 2 }]);
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch('http://127.0.0.1:4010/webhooks/corrected', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Webhook-Lab-Run-Id': runId },
      body: JSON.stringify({ id: 'payment_example', type: 'payment.succeeded', data: { orderId: 'order_example', quantity: 2 } }),
    });
    if (!response.ok) throw new Error(await response.text());
  }
  console.log((await query.query("SELECT (SELECT count(*)::int FROM fulfillments WHERE run_id=$1) AS fulfillments, (SELECT quantity FROM inventory WHERE run_id=$1 AND sku='sku_001') AS stock", [runId])).rows[0]);
} finally {
  await cleanupDemoFixtures(fixture, runId);
  await Promise.all([fixture.end(), query.end()]);
}
'@ | node --env-file-if-exists=.env --input-type=module
```

Expected: fulfillment count 1, stock 8. Change the endpoint to `flawed` for
count 2, stock 6. Each invocation uses a new run. Fixture preparation replaces
only that run's rows; `demoOrders(validatedScenario)` derives its referenced orders.

`npm.cmd` avoids PowerShell restrictions on `npm.ps1`.
See [architecture](docs/architecture.md) for service boundaries.

Dependency/configuration choices, scenario validation, and payment transaction
patterns were adapted from relevant modules of `suryaB-eng/webhook-lab` at
`e6a761182bd338f68dd439e260bb25b3d91bb44c`. Its Git history was not imported.
The reference MIT copyright notice is preserved in [LICENSE](LICENSE).
