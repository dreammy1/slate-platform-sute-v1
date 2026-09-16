import { configDefaults, defineConfig, type ViteUserConfig } from 'vitest/config';

import { isCi } from '../src/env.ts';

/** Test file globs matched by the unit preset. */
export const UNIT_INCLUDE = [
  'src/**/*.test.ts',
  'src/**/*.test.tsx',
  'tests/**/*.test.ts',
  'tests/**/*.test.tsx',
] as const;

/** Test file globs matched by the integration preset. */
export const INTEGRATION_INCLUDE = [
  'src/**/*.integration.test.ts',
  'tests/**/*.integration.test.ts',
] as const;

/** Globs that must never be picked up by the unit preset. */
export const INTEGRATION_EXCLUDE = [
  '**/*.integration.test.ts',
  '**/*.integration.test.tsx',
] as const;

export const DEFAULT_TEST_TIMEOUT_MS = 10_000;
export const DEFAULT_HOOK_TIMEOUT_MS = 10_000;

/** Databases and containers are slower than pure unit tests. */
export const DEFAULT_INTEGRATION_TEST_TIMEOUT_MS = 30_000;
export const DEFAULT_INTEGRATION_HOOK_TIMEOUT_MS = 30_000;

/** Test environments supported by the presets. */
export type SlateTestEnvironment = 'node' | 'jsdom' | 'happy-dom';

export interface SlateVitestPresetOptions {
  /** Project name reported by Vitest, e.g. `@slate/db:unit`. */
  readonly name: string;
  /** `test.include` globs, resolved relative to the workspace root. */
  readonly include: readonly string[];
  /** Extra `test.exclude` globs appended to Vitest's defaults. */
  readonly exclude?: readonly string[] | undefined;
  /** Files executed once before each test file in the same worker. */
  readonly setupFiles?: readonly string[] | undefined;
  /** Per-test timeout in milliseconds. */
  readonly testTimeout?: number | undefined;
  /** Per-`beforeAll`/`afterAll` hook timeout in milliseconds. */
  readonly hookTimeout?: number | undefined;
  /** Run test files in parallel (default) or sequentially. */
  readonly fileParallelism?: boolean | undefined;
  /** Vitest environment; server-side code uses `node`. */
  readonly environment?: SlateTestEnvironment | undefined;
}

/**
 * Shared Vitest configuration for every workspace in the Slate monorepo.
 *
 * Keeping the presets in a single workspace package means every package is
 * tested the same way: explicit imports (no `globals`), restored mocks between
 * tests, `node` as the default environment and identical timeouts. Presets are
 * consumed as TypeScript source, exactly like the other `@slate/*` packages.
 *
 * @example
 * ```ts
 * // packages/db/vitest.config.ts
 * import { defineSlateUnitConfig } from '@slate/testing/vitest/unit';
 *
 * export default defineSlateUnitConfig({ name: '@slate/db:unit', include: ['src/**\/*.test.ts'] });
 * ```
 */
export function defineSlateVitestConfig(options: SlateVitestPresetOptions): ViteUserConfig {
  const {
    name,
    include,
    exclude = [],
    setupFiles = [],
    testTimeout = DEFAULT_TEST_TIMEOUT_MS,
    hookTimeout = DEFAULT_HOOK_TIMEOUT_MS,
    fileParallelism = true,
    environment = 'node',
  } = options;

  return defineConfig({
    test: {
      name,
      environment,
      include: [...include],
      exclude: [...configDefaults.exclude, ...exclude],
      setupFiles: [...setupFiles],
      testTimeout,
      hookTimeout,
      fileParallelism,
      // Tests import from `vitest` explicitly: no ambient globals, no hidden
      // coupling between the test runner and the TypeScript configuration.
      globals: false,
      // Every test starts from a clean slate.
      restoreMocks: true,
      clearMocks: true,
      unstubEnvs: true,
      unstubGlobals: true,
      // `github-actions` annotates failures inline in the CI log.
      reporters: isCi() ? ['default', 'github-actions'] : ['default'],
      coverage: {
        provider: 'v8',
        reporter: ['text', 'lcov'],
        reportsDirectory: 'coverage',
        exclude: ['**/*.config.ts', '**/*.d.ts', '**/dist/**', '**/coverage/**', '**/*.test.ts'],
      },
    },
  });
}
