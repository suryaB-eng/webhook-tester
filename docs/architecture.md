# Architecture

## Current boundaries

`apps/web` on port 4173 lists saved scenarios and launches either demo profile.
Its editor keeps drafts local, including incomplete JSON and numeric input.
Shared contracts validate supported payment/status documents for editing,
import/export, API saves, and enqueue. Exports contain only the scenario and an
allowlisted target ID. Imports are limited to 1 MiB of UTF-8 before parsing.
Revision conflicts preserve the unsaved draft. The run view polls saved results;
hash navigation keeps the run ID across refresh. Vite proxies `/api` to Fastify.

`apps/api` on port 4000 exposes health, public targets, scenario creation,
readback, revision-checked updates, duplication, enqueue, and run readback.
Mutations require configured local Origin and JSON. Endpoints stay in server
configuration. Enqueue locks the saved scenario, resolves the selected or default
profile from that snapshot, and stores the validated document, sanitized
`{id,name}` target, planned evidence, and queued job together. The API sends no
webhooks.

`packages/db` separates scenario and run persistence. The application database
holds scenarios, runs, jobs, deliveries, and assertions. Scenario updates lock
the row, compare its integer revision atomically, and increment it. Stale saves
return 409 with the current revision. Duplicates have independent IDs; source
edits never change existing run snapshots. Seeds insert only missing presets.
The application login cannot create schema objects, alter saved run snapshots,
or access target tables. A forward migration adds revisions to existing rows.

`apps/worker` owns one run through a dedicated PostgreSQL session advisory lock.
It marks abandoned running jobs interrupted, claims a queued job atomically,
and commits before HTTP work. Ownership probes precede dispatch and follow
HTTP work. `packages/runner` processes steps in order, delays after previous
completion, and bounds concurrent requests within that run. Abort/error stops
new dispatches and awaits started promises. Request timeouts begin at dispatch;
an overall deadline bounds execution. Responses are capped at 16 KiB, redirects
are disabled, and transport IDs remain distinct from business-event IDs.

The worker derives run-scoped payment/status fixtures with `demoOrders`.
Assertions bind `$1` to run ID through a separate SELECT-only login inside
`BEGIN READ ONLY`, with a statement timeout of at most 2000 ms. Each result must
be one row/one column named `value`, containing a JSON scalar. Comparison is
strict, including number versus string. Results are saved before normal cleanup.
Non-2xx responses and false assertions fail a run; setup, query, transport,
timeout, or cleanup failures produce error. Ownership loss produces interrupted.
Uncertain HTTP work and failed observation writes retain run-scoped fixtures;
aborting HTTP does not prove target work stopped. Abandoned jobs are not replayed.

`apps/demo-target` on port 4010 exposes synchronous profiles backed by
`demo_target`. Without deduplication applies every payment and arriving status.
With deduplication claims `(run_id,business_event_id)` and commits payment,
inventory, and fulfillment together. Status updates require a greater incoming
version; stale/equal versions succeed unchanged. Missing fixtures fail clearly.
Target application, fixture, and assertion roles have separate permissions.

Compose applies migrations before dependent services and publishes ports on
loopback only. Tests use disposable PostgreSQL on port 55433, verify its marker,
and stop the Compose worker while test-owned workers run.

## Intended behavior

Stronger recovery and live updates can build on the current ownership, dispatch,
evidence, and cleanup boundaries. Streaming, full history, rerun, and comparison
are intended and are not implemented.
