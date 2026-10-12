CREATE TABLE run_events (
  cursor bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN (
    'run.queued','run.started','run.phase','run.completed',
    'delivery.scheduled','delivery.started','delivery.completed',
    'delivery.interrupted','assertion.completed'
  )),
  payload jsonb NOT NULL CHECK (
    jsonb_typeof(payload) = 'object' AND
    payload - ARRAY['status','phase','deliveryId','outcome','httpStatus',
      'assertionId','assertionName','expected','actual','assertionStatus']::text[] = '{}'::jsonb
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX run_events_replay ON run_events(run_id,cursor);
GRANT SELECT, INSERT ON run_events TO webhook_tester_app;
GRANT USAGE ON SEQUENCE run_events_cursor_seq TO webhook_tester_app;
