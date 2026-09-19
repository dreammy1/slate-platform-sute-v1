import { fileURLToPath } from 'node:url';

import { defineSlateUnitConfig } from '@slate/testing/vitest/unit';

/**
 * The unit suite runs in Node (the preset's default): the browser client is
 * exercised through an injected `fetch`, and the server modules are Node code. The
 * server guard is tested by simulating a browser global rather than by pretending
 * to be one.
 *
 * The project root is pinned to this config file's directory. Vitest resolves the
 * shared preset's source test globs (`*.test.ts` under `src/`) against `root`,
 * which otherwise defaults to `process.cwd()`; invoking the suite from the
 * repository root (`npx vitest run --config packages/api-client/vitest.config.ts`)
 * exits 1 with "No test files found" because the globs resolve against the repo
 * root. Pinning the root makes discovery location-independent and leaves the
 * per-workspace `npm run test:unit` run (cwd = package dir) unchanged.
 */
const root = fileURLToPath(new URL('.', import.meta.url));

export default {
  ...defineSlateUnitConfig({ name: '@slate/api-client:unit' }),
  root,
};
