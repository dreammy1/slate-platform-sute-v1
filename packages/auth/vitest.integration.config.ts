import { defineSlateIntegrationConfig } from '@slate/testing/vitest/integration';

/**
 * PostgreSQL integration tests for the auth layer, executed against the
 * isolated database from `TEST_DATABASE_URL` (see `.env.example`).
 *
 * Run `docker compose up -d` first; without a database the suites skip locally
 * and fail in CI. Every suite runs the SLATE-200 migrations inside its own
 * schema via `@slate/testing/postgres`'s `createIsolatedDatabase`, and
 * extends them with the SLATE-202 auth seed so the evaluator can be exercised
 * end-to-end.
 */
export default defineSlateIntegrationConfig({ name: '@slate/auth:integration' });
