import { defineSlateIntegrationConfig } from './vitest/integration.ts';

/**
 * PostgreSQL integration tests for the harness, executed against the isolated
 * database from `TEST_DATABASE_URL` (see `.env.example`).
 *
 * Run `docker compose up -d` first; without a database the suites skip locally
 * and fail in CI.
 */
export default defineSlateIntegrationConfig({ name: '@slate/testing:integration' });
