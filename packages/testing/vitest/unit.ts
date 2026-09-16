import type { ViteUserConfig } from 'vitest/config';

import {
  DEFAULT_HOOK_TIMEOUT_MS,
  DEFAULT_TEST_TIMEOUT_MS,
  defineSlateVitestConfig,
  INTEGRATION_EXCLUDE,
  UNIT_INCLUDE,
  type SlateTestEnvironment,
  type SlateVitestPresetOptions,
} from './base.ts';

export type SlateUnitConfigOptions = Omit<SlateVitestPresetOptions, 'include' | 'exclude'> & {
  /** Defaults to {@link UNIT_INCLUDE}. */
  readonly include?: readonly string[] | undefined;
  /** Appended to Vitest's defaults *and* to {@link INTEGRATION_EXCLUDE}. */
  readonly exclude?: readonly string[] | undefined;
};

/**
 * Unit test preset: fast, hermetic tests that need no external service and may
 * run in parallel in every worker. Integration suites
 * (`*.integration.test.ts`) are excluded so they can never run here by mistake.
 */
export function defineSlateUnitConfig(options: SlateUnitConfigOptions): ViteUserConfig {
  const {
    name,
    include = UNIT_INCLUDE,
    exclude = [],
    setupFiles,
    testTimeout = DEFAULT_TEST_TIMEOUT_MS,
    hookTimeout = DEFAULT_HOOK_TIMEOUT_MS,
    fileParallelism,
    environment,
  } = options;

  return defineSlateVitestConfig({
    name,
    include,
    exclude: [...INTEGRATION_EXCLUDE, ...exclude],
    setupFiles,
    testTimeout,
    hookTimeout,
    fileParallelism,
    environment: environment as SlateTestEnvironment | undefined,
  });
}
