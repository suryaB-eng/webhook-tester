# Architecture

## Current boundaries

`apps/web` on port 4173 lists saved scenarios and launches either demo
profile. Its run view polls a persisted run ID and shows selectable delivery
details and scalar assertion results. Hash navigation preserves that ID across
refresh. Vite proxies browser `/api` requests to Fastify on port 4000.

`apps/api` exposes health, public targets, saved scenarios, enqueue, and run
readback. Mutations require configured local Origin and JSON. Enqueue validates
the scenario with the existing shared contracts, applies the selected demo
target, and atomically saves a full scenario snapshot, a sanitized `{id,name}`
target snapshot, planned evidence rows, and a queued job. The API sends no
webhooks. Server configuration resolves endpoints.

`packages/db` splits saved-scenario and run persistence responsibilities.
The application database holds scenarios, runs, jobs, deliveries, and assertions.
Seeds insert only missing One payment, Sequential duplicate payment, Concurrent
duplicate payment, and Status version 2 before version 1 presets.
The runtime login can use these tables but cannot create schema objects, alter
saved run snapshots, or access target tables.

`apps/worker` holds a dedicated PostgreSQL session advisory lock for one run.
It marks abandoned running jobs interrupted, atomically claims a queued job,
and commits before network I/O. Ownership probes precede dispatch and follow
HTTP work. The owning database session serializes probes and evidence writes;
HTTP requests may overlap within that one owned run. `packages/runner` processes
steps in array order, delays after the previous step finishes, and schedules each
eligible step's deliveries together. Sequential steps await each response;
concurrent steps dispatch up to the scenario's ceiling (1 to 10). Errors and aborts
stop new dispatches and await started dispatch promises. Request timeouts start
at dispatch, excluding slot waiting; an overall deadline bounds execution.
Saving observations and final cleanup use separate bounded database budgets.
Responses are capped at 16 KiB and redirects are not followed. Delivery IDs
remain distinct from logical business-event IDs.

The worker derives supported payment/status order fixtures using `demoOrders`,
with initial status created/version 0. Assertions bind `$1` to run ID and use a separate SELECT-only login inside
`BEGIN READ ONLY` with a statement timeout of at most 2000 ms. Results must
have one row and one column named `value`, containing a JSON scalar.
Comparison is strict, including number versus string.

Delivery and assertion observations are saved before normal fixture cleanup.
Non-2xx responses or false assertions yield failed; setup, query, transport,
timeout, or cleanup failures yield error. Lost ownership yields interrupted.
Uncertain in-flight HTTP work and failed observation writes keep run-scoped
fixtures; aborting a request does not prove target processing stopped.
New owners never replay abandoned jobs.

`apps/demo-target` on port 4010 exposes two synchronous profiles
and database-backed health endpoint. Both require matching run-scoped fixtures.
Without deduplication applies every payment and overwrites every arriving status.
With deduplication claims `(run_id,business_event_id)` and commits payment state,
inventory, and fulfillment together. Status updates atomically require an incoming
version greater than the stored version; stale/equal versions succeed unchanged.
The target application, fixture, and assertion logins have distinct
permissions in `demo_target`.

Compose applies tracked migrations before dependent services start.
Published ports bind to host loopback. Tests use a separate disposable
PostgreSQL instance on port 55433 and verify its marker before mutations.
The Compose worker is stopped while test-owned workers run.

## Intended behavior

Stronger recovery can build on the current ownership, claim, dispatch, evidence,
and cleanup boundaries. An editor, live events, streaming, full history, rerun,
and comparison are intended and are not implemented.
