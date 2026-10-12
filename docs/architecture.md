# Architecture

## Current boundaries

`apps/web` serves the React shell on port 4173. It proxies browser requests
from `/api/health` to Fastify `apps/api` on port 4000. The API exposes only
`GET /health`; it has no scenario storage or run launch endpoint.

`packages/contracts` validates `ScenarioV1` structure, IDs, event references,
scalar assertion expectations, and size/limit bounds. Steps accept sequential
mode only. Demo validation additionally permits only `demo-flawed` and
`demo-corrected` payment targets, consistent quantities per order, and identical
payloads for repeated logical business-event IDs. It derives one fixture order
per referenced order ID; it does not promise arbitrary targets.

`apps/demo-target` on port 4010 exposes two payment webhook profiles and a
database-backed health check. Both POST routes require a UUID in
`X-Webhook-Lab-Run-Id` and matching run-scoped fixtures. Invalid requests return
400, oversized bodies 413, and missing/inconsistent fixtures or failed effects 409.

The flawed profile applies each delivery. The corrected profile claims
`(run_id, business_event_id)`, guards the unpaid-to-paid transition, decrements
available inventory, and inserts a fulfillment in one PostgreSQL transaction.
An effect failure rolls back the claim and paid transition too. Transport IDs
are irrelevant to deduplication.

## Database setup

`packages/db` contains connection, transaction, migration, and reusable fixture
helpers. PostgreSQL hosts `webhook_tester` and `demo_target`. The application
login currently has CONNECT only because no application tables are needed yet.
Target tables are `orders`, `inventory`, `fulfillments`, and
`processed_business_events`, each scoped by run ID.

The target application login can read fixtures, update only payment-state and
inventory columns, and insert effects/claims. The fixture login can prepare and
delete run-scoped rows. The assertion login can SELECT only, with a read-only
session default and statement timeout. Database owners and the migration
administrator are separate from the target runtime login.

Fixture preparation creates one order per supplied order ID and `sku_001`
stock 10. Setup and cleanup share their deletion helper and use transactions;
cleanup deletes only the specified run. There are no worker-owned fixture lists.

Compose applies tracked migrations before dependent services start. Migrations
upgrade existing local volumes and serialize execution with an advisory lock;
applied-file checksums detect modified migration history. All published ports
bind to host loopback. Tests use a separate disposable PostgreSQL instance
on port 55433 and require its dedicated test database marker before mutations.

## Intended separation

A future worker is intended to consume validated scenarios, derive demo fixtures,
and deliver webhooks outside API request handlers. Scenario persistence belongs
in the application database. The worker, execution queue, assertion execution,
editor, status events, streaming, and comparison are not implemented.
