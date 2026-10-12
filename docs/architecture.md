# Architecture

## Current services

`apps/web` is a React shell served by Vite on port 4173. It has navigation,
an empty scenario state, and a connection check. The browser requests
`/api/health` on the web origin; Vite removes the `/api` prefix and proxies
to the Fastify service.

`apps/api` listens on port 4000 and exposes `GET /health`, returning
`{"status":"ok"}`. This is an API liveness check, not database readiness.
The API does not access PostgreSQL yet. The UI reports a connection only after
a successful response with that payload; failures can be retried.

Compose runs the web, API, and PostgreSQL services. PostgreSQL exposes host port
55432 and persists data in a named volume. Initialization creates
`webhook_tester` owned by `webhook_tester_app` and `demo_target` owned by
`demo_target_owner`. Public database connections are revoked so these owners
remain separate. There are no application tables or migrations.

All published ports bind to the host loopback interface. Container processes
listen on their internal interfaces so services can reach one another.
The web health check includes the proxied API request; PostgreSQL's health check
checks that both databases exist and accept queries.

## Intended separation

Future scenario storage will belong to the application database. A separate
worker is intended to claim execution work and make outbound webhook requests,
so execution does not run inside API request handlers. Demo target data is
intended to remain in its separate database. These behaviors, the worker, and
demo handlers are not implemented.
