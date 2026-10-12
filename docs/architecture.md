# Architecture

## Current boundaries

`apps/web` on port 4173 lists saved scenarios and launches either payment
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
Seeds insert only missing One payment and Sequential duplicate payment presets.
The runtime login can use these tables but cannot create schema objects, alter
saved run snapshots, or access target tables.

`apps/worker` holds a dedicated PostgreSQL session advisory lock for one run.
It marks abandoned running jobs interrupted, atomically claims a queued job,
and commits before network I/O. Ownership probes precede dispatch and follow
HTTP work. Each step's delay begins after the preceding step completes.
Request timeouts start at dispatch; an overall deadline bounds execution.
Saving observations and final cleanup use separate bounded database budgets.
Responses are capped at 16 KiB and redirects are not followed. Delivery IDs
remain distinct from logical payment IDs.

The worker derives supported order fixtures using `demoOrders`. Assertions
bind `$1` to run ID and use a separate SELECT-only login inside
`BEGIN READ ONLY` with a statement timeout of at most 2000 ms. Results must
have one row and one column named `value`, containing a JSON scalar.
Comparison is strict, including number versus string.

Delivery and assertion observations are saved before normal fixture cleanup.
Non-2xx responses or false assertions yield failed; setup, query, transport,
timeout, or cleanup failures yield error. Lost ownership yields interrupted.
Uncertain in-flight HTTP work and failed observation writes keep run-scoped
fixtures; aborting a request does not prove target processing stopped.
New owners never replay
abandoned jobs.

`apps/demo-target` on port 4010 retains its two synchronous payment profiles
and database-backed health endpoint. Both require matching run-scoped fixtures.
Without deduplication applies every delivery; With deduplication claims
`(run_id,business_event_id)` and commits payment state, inventory, and fulfillment
together. The target application, fixture, and assertion logins have distinct
permissions in `demo_target`.

Compose applies tracked migrations before dependent services start.
Published ports bind to host loopback. Tests use a separate disposable
PostgreSQL instance on port 55433 and verify its marker before mutations.
The Compose worker is stopped while test-owned workers run.

## Intended behavior

Stronger recovery can build on the current ownership, claim, dispatch, evidence,
and cleanup boundaries. An editor, concurrent delivery, additional status
profiles, live events, streaming, full history, rerun, and comparison are not
implemented.
