REVOKE ALL ON SCHEMA public FROM PUBLIC, demo_target_app, demo_target_fixture, demo_target_query;
GRANT USAGE ON SCHEMA public TO demo_target_app, demo_target_fixture, demo_target_query;

CREATE TABLE orders (
  run_id uuid NOT NULL,
  order_id text NOT NULL CHECK (length(btrim(order_id)) > 0 AND length(order_id) <= 200),
  paid boolean NOT NULL DEFAULT false,
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 10),
  PRIMARY KEY (run_id, order_id)
);

CREATE TABLE inventory (
  run_id uuid NOT NULL,
  sku text NOT NULL,
  quantity integer NOT NULL CHECK (quantity >= 0),
  PRIMARY KEY (run_id, sku)
);

CREATE TABLE fulfillments (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL,
  order_id text NOT NULL,
  business_event_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (run_id, order_id) REFERENCES orders (run_id, order_id)
);

CREATE TABLE processed_business_events (
  run_id uuid NOT NULL,
  business_event_id text NOT NULL,
  order_id text NOT NULL,
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 10),
  PRIMARY KEY (run_id, business_event_id),
  FOREIGN KEY (run_id, order_id) REFERENCES orders (run_id, order_id)
);

GRANT SELECT ON orders, inventory, fulfillments, processed_business_events TO demo_target_app;
GRANT UPDATE (paid) ON orders TO demo_target_app;
GRANT UPDATE (quantity) ON inventory TO demo_target_app;
GRANT INSERT ON fulfillments, processed_business_events TO demo_target_app;
GRANT SELECT, INSERT, DELETE ON orders, inventory, fulfillments, processed_business_events TO demo_target_fixture;
GRANT SELECT ON orders, inventory, fulfillments, processed_business_events TO demo_target_query;
