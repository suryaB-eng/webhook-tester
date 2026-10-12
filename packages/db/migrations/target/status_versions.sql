ALTER TABLE orders
  ADD COLUMN status text NOT NULL DEFAULT 'created'
    CHECK (length(btrim(status, E' \t\n\r\f\v')) > 0 AND length(status) <= 100),
  ADD COLUMN version bigint NOT NULL DEFAULT 0 CHECK (version >= 0);

GRANT UPDATE (status, version) ON orders TO demo_target_app;
