# Architecture

`apps/web` on port 4173 lists and edits supported payment/status scenarios.
Drafts remain local until Save; shared contracts validate editing, import/export,
API saves, and enqueue. Imports are limited to 1 MiB UTF-8, and revision conflicts
preserve drafts. Vite proxies `/api` to Fastify. Hash navigation preserves saved
run and comparison IDs across refresh. History loads bounded summary pages;
comparison reads two stored responses, aligns evidence by configuration ID,
and shows missing items, changed settings, and recorded rerun relationships.
Unrelated outcomes do not by themselves establish a code fix.

`apps/api` on port 4000 exposes health, public targets, scenario CRUD/duplication,
enqueue, run readback, history, rerun, and JSON/SSE event replay. Mutations require
configured local Origin and JSON. Endpoints remain server configuration; the API
sends no webhooks. Enqueue locks a saved scenario and atomically stores its validated
snapshot, sanitized `{id,name}` target, planned evidence, job, and queued event.
Rerun locks a terminal source run, copies its frozen validated scenario, changes
only the allowlisted target ID, and resolves a fresh public target snapshot.
Its new ID, sourceRunId, targetOverride, evidence, job, and event commit together.
It neither reads the edited source scenario nor resends the old run.

`packages/db` separates scenario, run, and history persistence. Scenario updates
compare and increment revisions under a row lock; stale saves return 409.
Seeds insert missing presets without replacing edits. The application role cannot
alter saved snapshots or lineage, create schema objects, or access target tables.
History orders by created timestamp and ID descending; the opaque older-than
cursor retains PostgreSQL microseconds and the ID tie-breaker. Pages cap at 50.

Result transitions and allowlisted events commit together. A run row lock orders
event insertion and commit; bigint cursors travel as decimal strings. Run results,
events, and cursor use one repeatable-read snapshot. The browser loads that snapshot
before subscribing, deduplicates cursors, and reloads coherent results on events.
Replay resumes after the greater of `after` and valid `Last-Event-ID`.
SSE idle comments provide heartbeats; disconnect stops polling without cancelling
the worker. Event payloads exclude request bodies, response excerpts, SQL,
endpoints, and credentials.

`apps/worker` owns one run through a dedicated PostgreSQL session advisory lock,
claims jobs atomically, and commits before HTTP. Ownership probes use that same
session at scheduling/dispatch boundaries and after responses. Session loss stops
new deliveries; a successor interrupts abandoned work without automatic replay.
Conditional writes preserve terminal states against late responses. Started work
is awaited where possible, and uncertain effects retain isolated fixtures.
Aborting HTTP does not prove target work stopped.

`packages/runner` processes steps in order, delays after previous completion,
and bounds concurrent requests within one run. Request timeout starts at dispatch;
an overall deadline bounds execution. Responses cap at 16 KiB and redirects are
disabled. Transport IDs remain distinct from logical business-event IDs.
Assertions bind `$1` to run ID under SELECT-only credentials in `BEGIN READ ONLY`,
with at most 2000 ms statement timeout and one scalar column named value.
Scalar comparison is strict. Results precede normal cleanup. Non-2xx responses
or false assertions fail; setup/query/transport/timeout/cleanup failures are errors,
and ownership loss is interrupted.

`apps/demo-target` on port 4010 uses run-scoped fixtures in `demo_target`.
Without deduplication applies each payment and arriving status. With deduplication
claims `(run_id,business_event_id)` and commits payment/inventory/fulfillment together;
status changes require a greater version. Stale/equal versions succeed unchanged.
Fixtures derive from supported order IDs/quantities, with sku_001 stock 10 and
initial status created/version 0. Target application, fixture, and assertion roles
have separate permissions. Compose migrates before dependent services and binds
ports to loopback. Tests use marked disposable PostgreSQL on 55433 while the
Compose worker is stopped.
