import { integrationEnabled, isCi, loadRootEnv, TEST_DATABASE_URL_VARIABLE } from './env.ts';

/**
 * Setup file wired into every integration suite by
 * `@slate/testing/vitest/integration`.
 *
 * 1. Loads the repository root `.env`, the same file Docker Compose uses, so
 *    `TEST_DATABASE_URL` from `.env.example` is picked up automatically.
 * 2. Refuses to skip silently in CI: a missing test database is a hard failure
 *    there, because "integration tests did not run" must never look like a
 *    passing pipeline (Master Plan, Section 2).
 * 3. On a developer machine without a database it warns once and lets the
 *    suites skip themselves via `describe.skipIf(!integrationEnabled())`.
 */
loadRootEnv();

if (!integrationEnabled()) {
  const message = `[slate/testing] ${TEST_DATABASE_URL_VARIABLE} is not set, integration suites will be skipped. Start the local stack with "docker compose up -d" and copy ".env.example" to ".env".`;

  if (isCi()) {
    throw new Error(`${message} Integration coverage is mandatory in CI.`);
  }

  console.warn(message);
}
