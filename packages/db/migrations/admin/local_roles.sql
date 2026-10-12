DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'demo_target_app') THEN
    CREATE ROLE demo_target_app LOGIN PASSWORD 'target_app_local_only';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'demo_target_fixture') THEN
    CREATE ROLE demo_target_fixture LOGIN PASSWORD 'fixture_local_only';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'demo_target_query') THEN
    CREATE ROLE demo_target_query LOGIN PASSWORD 'query_local_only';
  END IF;
END $$;

ALTER DATABASE webhook_tester OWNER TO postgres;
REVOKE ALL ON DATABASE webhook_tester FROM PUBLIC, webhook_tester_app;
GRANT CONNECT ON DATABASE webhook_tester TO webhook_tester_app;

REVOKE ALL ON DATABASE demo_target FROM PUBLIC, webhook_tester_app,
  demo_target_app, demo_target_fixture, demo_target_query;
GRANT CONNECT ON DATABASE demo_target TO demo_target_owner,
  demo_target_app, demo_target_fixture, demo_target_query;

ALTER ROLE demo_target_query SET default_transaction_read_only = on;
ALTER ROLE demo_target_query SET statement_timeout = '2s';
