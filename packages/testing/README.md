# @slate/testing

Shared Vitest presets and the test harness for every workspace in the Slate
Next-Gen Platform monorepo. Keeping the presets in a single package means all
apps and packages are tested the same way — identical reporters, timeouts,
environment and cleanup rules — and that the PostgreSQL integration harness only
has to be written once.

npm links this package into the workspace automatically (`packages/*` is part of
the root `workspaces` field) — nothing is published to a registry. Like the other
`@slate/*` packages it is consumed as TypeScript source, which is why relative
imports inside it carry explicit `.ts` extensions: that keeps the presets
loadable by Vite's native config loader.

## Vitest presets

| Preset                              | Use case                                                    |
| ----------------------------------- | ----------------------------------------------------------- |
| `@slate/testing/vitest/unit`        | Fast, hermetic unit tests that need no external service.    |
| `@slate/testing/vitest/integration` | Suites that need real infrastructure (PostgreSQL).          |
| `@slate/testing/vitest/base`        | Building block for bespoke configs; both presets extend it. |

A workspace declares both configs and points its scripts at them:

```ts
// packages/db/vitest.config.ts
import { defineSlateUnitConfig } from '@slate/testing/vitest/unit';

export default defineSlateUnitConfig({ name: '@slate/db:unit' });
```

```ts
// packages/db/vitest.integration.config.ts
import { defineSlateIntegrationConfig } from '@slate/testing/vitest/integration';

export default defineSlateIntegrationConfig({ name: '@slate/db:integration' });
```

```json
{
  "scripts": {
    "test:unit": "vitest run --config vitest.config.ts",
    "test:integration": "vitest run --config vitest.integration.config.ts"
  }
}
```

The root `npm run test:unit` / `npm run test:integration` scripts fan out to every
workspace with `--if-present`, and `.github/workflows/ci.yml` calls those exact
scripts, so a package is in the pipeline as soon as the two scripts exist.

### File naming

- `*.test.ts` — unit tests, matched by the unit preset.
- `*.integration.test.ts` — integration tests, matched by the integration preset
  and explicitly excluded from the unit preset, so they can never run in the
  unit job by mistake.

### Conventions baked into the presets

- `globals: false`: tests import `describe`/`it`/`expect` from `vitest`
  explicitly, so the runner and the TypeScript config stay independent.
- `restoreMocks`, `clearMocks`, `unstubEnvs` and `unstubGlobals` are enabled, so
  every test starts from a clean slate.
- `environment: 'node'` by default; a package opts into a DOM environment
  (`jsdom`, `happy-dom`) through the preset options.
- Unit timeouts are 10s, integration timeouts 30s.
- Coverage uses the `v8` provider with `text` and `lcov` reporters.
- On CI the `github-actions` reporter is added, so failures are annotated inline.

## Environment helpers

`@slate/testing/env` loads the repository root `.env` (the same file Docker
Compose reads) with pre-existing variables winning, so a shell or CI value always
overrides a developer's local file:

| Export                       | Purpose                                                        |
| ---------------------------- | -------------------------------------------------------------- |
| `TEST_DATABASE_URL_VARIABLE` | Name of the variable integration suites read.                  |
| `loadRootEnv()`              | Loads the root `.env`; returns the path and whether it loaded. |
| `testDatabaseUrl()`          | The configured test database URL, or `undefined`.              |
| `integrationEnabled()`       | `true` when an isolated test database is configured.           |
| `requireTestDatabaseUrl()`   | Same, but throws an error explaining how to provision one.     |
| `isCi()`                     | CI detection shared by the presets and the integration guard.  |

`@slate/testing/paths` exposes `findRepoRoot()` / `tryFindRepoRoot()`, which walk
up from the current directory to the `package.json` that declares `workspaces`.

## PostgreSQL integration harness

Integration suites never touch `DATABASE_URL` and never share a schema. Each
suite asks `@slate/testing/postgres` for its own database namespace:

```ts
// packages/db/src/repositories/booking.integration.test.ts
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { integrationEnabled } from '@slate/testing/env';
import { createIsolatedDatabase, type IsolatedDatabase } from '@slate/testing/postgres';

const describeIntegration = describe.skipIf(!integrationEnabled());

describeIntegration('booking repository', () => {
  let database: IsolatedDatabase;
  let client: Client;

  beforeAll(async () => {
    database = await createIsolatedDatabase({
      schemaPrefix: 'slate_booking',
      setup: async (setupClient) => {
        await setupClient.query(
          'CREATE TABLE bookings (id serial PRIMARY KEY, status text NOT NULL)',
        );
      },
    });
    client = await database.createClient();
  });

  afterAll(async () => {
    await client.end();
    await database.dispose();
  });

  it('persists a booking', async () => {
    await client.query('INSERT INTO bookings (status) VALUES ($1)', ['confirmed']);

    const result = await client.query<{ status: string }>('SELECT status FROM bookings');

    expect(result.rows).toEqual([{ status: 'confirmed' }]);
  });
});
```

| Export                            | Purpose                                                   |
| --------------------------------- | --------------------------------------------------------- |
| `createIsolatedDatabase(options)` | Creates a dedicated schema, returns clients scoped to it. |
| `withIsolatedDatabase(run, opts)` | Same with guaranteed teardown for one-off usage.          |
| `connectWithSchema(url, schema)`  | Client whose `search_path` points at one schema.          |
| `dropSchema(url, schema)`         | Drops a schema (cascade); idempotent.                     |
| `generateSchemaName(prefix)`      | Unique, lowercase, ≤63-byte schema name; never `public`.  |
| `assertValidSchemaName(name)`     | Validates before interpolation into raw SQL.              |
| `quoteIdentifier(identifier)`     | Quotes an identifier for raw SQL.                         |

How isolation works:

- Every suite gets `<prefix>_<12 random characters>` inside the database
  referenced by `TEST_DATABASE_URL`. `search_path` is scoped to that schema for
  every generated client, so unqualified DDL/DML stays inside it and `public` is
  never touched.
- Suites therefore run in parallel (`fileParallelism` stays enabled) and a suite
  can be replayed in isolation, because nothing is shared.
- `dispose()` drops the schema with `CASCADE`; schemas are created through an
  admin connection and removed again on teardown, so a crashed suite leaves at
  most one orphan schema behind.
- Schema names are validated (`/^[a-z_][a-z0-9_]*$/`, ≤63 bytes) before they are
  interpolated, so a caller-supplied prefix can never inject SQL.

## Running the integration suites locally

```bash
docker compose up -d          # starts PostgreSQL 16 and creates slate_test
cp .env.example .env          # provides TEST_DATABASE_URL
npm run test:integration      # runs every workspace's integration suites
```

Without a database the suites skip locally, but **not** in CI:
`@slate/testing/integration-setup` — loaded automatically by the integration
preset — throws when `TEST_DATABASE_URL` is missing while `CI` is set, so a
pipeline can never report success because integration coverage silently
disappeared.

## Adding a workspace to the pipeline

1. Add `vitest.config.ts` / `vitest.integration.config.ts` using the presets
   above, or import `defineSlateVitestConfig` from `@slate/testing/vitest/base`.
2. Add `test:unit` (and, once the package has database code, `test:integration`)
   scripts to its `package.json`.
3. Run `npm install` from the repository root so npm links the workspace, then
   `npm run verify`.

`.github/workflows/ci.yml` chains the gates in the order the Master Plan
requires — `install → lint → typecheck → unit → integration → build → security` —
and the `integration` job provisions the PostgreSQL service container that
matches `docker-compose.yml`.
