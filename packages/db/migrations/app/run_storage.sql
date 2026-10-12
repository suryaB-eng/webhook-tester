GRANT USAGE ON SCHEMA public TO webhook_tester_app;

CREATE TABLE scenarios (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 100),
  definition jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE runs (
  id uuid PRIMARY KEY,
  scenario_snapshot jsonb NOT NULL,
  target_snapshot jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('queued','running','passed','failed','error','interrupted')),
  phase text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  error text
);

CREATE TABLE jobs (
  run_id uuid PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('queued','running','completed','interrupted')),
  worker_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz
);
CREATE INDEX jobs_queued ON jobs(created_at,run_id) WHERE status='queued';

CREATE TABLE deliveries (
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  delivery_id text NOT NULL,
  step_id text NOT NULL,
  event_id text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  request_payload jsonb NOT NULL,
  scheduled_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  http_status integer CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  duration_ms integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
  response_excerpt text,
  response_truncated boolean NOT NULL DEFAULT false,
  outcome text NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending','ok','failed','error','interrupted')),
  error text,
  PRIMARY KEY(run_id,delivery_id),
  UNIQUE(run_id,ordinal)
);

CREATE TABLE assertions (
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  assertion_id text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  name text NOT NULL,
  query text NOT NULL,
  expected jsonb NOT NULL,
  actual jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','passed','failed','error')),
  error text,
  PRIMARY KEY(run_id,assertion_id),
  UNIQUE(run_id,ordinal)
);

GRANT SELECT, INSERT ON scenarios, runs, jobs, deliveries, assertions TO webhook_tester_app;
GRANT UPDATE ON scenarios, jobs, deliveries, assertions TO webhook_tester_app;
GRANT UPDATE(status,phase,started_at,completed_at,error) ON runs TO webhook_tester_app;
REVOKE ALL ON schema_migrations FROM webhook_tester_app;
