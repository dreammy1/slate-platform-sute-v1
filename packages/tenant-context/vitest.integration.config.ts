import { defineSlateIntegrationConfig } from '@slate/testing/vitest/integration';

/**
 * PostgreSQL integration tests for the tenant context layer, executed against
 * the isolated database from `TEST_DATABASE_URL` (see `.env.example`).
 *
 * Run `docker compose up -d` first; without a database the suites skip locally
 * and fail in CI. Every suite runs the SLATE-200 migrations inside its own
 * schema via `@slate/testing/postgres`'s `createIsolatedDatabase`.
 */
export default defineSlateIntegrationConfig({ name: '@slate/tenant-context:integration' });
