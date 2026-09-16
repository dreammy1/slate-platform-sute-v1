import type { ViteUserConfig } from 'vitest/config';

import {
  DEFAULT_INTEGRATION_HOOK_TIMEOUT_MS,
  DEFAULT_INTEGRATION_TEST_TIMEOUT_MS,
  defineSlateVitestConfig,
  INTEGRATION_INCLUDE,
  type SlateTestEnvironment,
  type SlateVitestPresetOptions,
} from './base.ts';

export type SlateIntegrationConfigOptions = Omit<
  SlateVitestPresetOptions,
  'include' | 'testTimeout' | 'hookTimeout'
> & {
  /** Defaults to {@link INTEGRATION_INCLUDE}. */
  readonly include?: readonly string[] | undefined;
  readonly testTimeout?: number | undefined;
  readonly hookTimeout?: number | undefined;
};

/**
 * Integration test preset for suites that talk to real infrastructure —
 * currently PostgreSQL through `TEST_DATABASE_URL` (Master Plan, Section 4:
 * "isolated PostgreSQL integration tests").
 *
 * The preset always loads the `@slate/testing/integration-setup` file, which
 * reads the repository root `.env` and fails fast in CI when
 * `TEST_DATABASE_URL` is missing, so a broken pipeline can never silently skip
 * integration coverage.
 *
 * Suites sharing one database must isolate themselves with
 * `createIsolatedDatabase()` from `@slate/testing/postgres`, which creates a
 * dedicated schema per suite and drops it again on teardown.
 */
export function defineSlateIntegrationConfig(
  options: SlateIntegrationConfigOptions,
): ViteUserConfig {
  const {
    name,
    include = INTEGRATION_INCLUDE,
    exclude = [],
    setupFiles = [],
    testTimeout = DEFAULT_INTEGRATION_TEST_TIMEOUT_MS,
    hookTimeout = DEFAULT_INTEGRATION_HOOK_TIMEOUT_MS,
    fileParallelism,
    environment,
  } = options;

  return defineSlateVitestConfig({
    name,
    include,
    exclude,
    setupFiles: ['@slate/testing/integration-setup', ...setupFiles],
    testTimeout,
    hookTimeout,
    fileParallelism,
    environment: environment as SlateTestEnvironment | undefined,
  });
}
