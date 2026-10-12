CREATE ROLE webhook_tester_app LOGIN PASSWORD 'app_local_only';
CREATE DATABASE webhook_tester OWNER webhook_tester_app;
REVOKE CONNECT ON DATABASE webhook_tester FROM PUBLIC;

CREATE ROLE demo_target_owner LOGIN PASSWORD 'target_owner_local_only';
CREATE DATABASE demo_target OWNER demo_target_owner;
REVOKE CONNECT ON DATABASE demo_target FROM PUBLIC;
