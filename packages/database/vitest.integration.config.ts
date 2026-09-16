import { defineSlateIntegrationConfig } from '@slate/testing/vitest/integration';

/**
 * PostgreSQL integration tests for the database abstraction, executed against
 * the isolated database from `TEST_DATABASE_URL` (see `.env.example`).
 *
 * Run `docker compose up -d` first; without a database the suites skip locally
 * and fail in CI. Every suite runs its migrations inside its own schema via
 * `@slate/testing/postgres`'s `createIsolatedDatabase`.
 */
export default defineSlateIntegrationConfig({ name: '@slate/database:integration' });
