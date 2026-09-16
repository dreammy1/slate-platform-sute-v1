-- =============================================================================
-- Slate Next-Gen Platform - PostgreSQL bootstrap
-- =============================================================================
-- Executed by the official postgres image entrypoint exactly once, on the
-- first start against an empty data volume.
--
-- The primary database (`POSTGRES_DB`, default `slate`) is created
-- automatically by the image entrypoint and is NOT created here.
-- This script only provisions the isolated database that backs
-- `TEST_DATABASE_URL` from `.env.example`, so integration tests never run
-- against the development database.
--
-- `\gexec` is a psql meta-command: it runs the query buffer below, then
-- executes each returned row as SQL. The SELECT yields a row only when the
-- database is missing, which keeps this script idempotent.
-- =============================================================================

SELECT 'CREATE DATABASE slate_test'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'slate_test')
\gexec

COMMENT ON DATABASE slate_test IS 'Slate Next-Gen Platform - isolated integration test database';