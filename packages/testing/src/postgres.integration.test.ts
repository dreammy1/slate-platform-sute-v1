import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { integrationEnabled, requireTestDatabaseUrl } from './env.ts';
import { connectWithSchema, createIsolatedDatabase, dropSchema } from './postgres.ts';

/**
 * A skip here is only possible outside CI: `@slate/testing/integration-setup`
 * throws in GitHub Actions when `TEST_DATABASE_URL` is missing, so integration
 * coverage can never silently disappear from the pipeline.
 */
const describeIntegration = describe.skipIf(!integrationEnabled());

/**
 * Fixture for the suite. A parameterless `query()` call runs through the
 * simple-query protocol, so several statements may be batched into one string —
 * but then every statement has to be terminated with a semicolon, otherwise
 * Postgres parses the whole buffer as one command and fails at the next keyword
 * (`syntax error at or near "CREATE"` for the index below).
 */
const SETUP_SQL = [
  'CREATE TABLE widgets (',
  '  id serial PRIMARY KEY,',
  '  name text NOT NULL,',
  '  quantity integer NOT NULL DEFAULT 0',
  ');',
  'CREATE UNIQUE INDEX widgets_name_key ON widgets (name);',
].join('\n');

describeIntegration('isolated PostgreSQL harness', () => {
  let database: Awaited<ReturnType<typeof createIsolatedDatabase>> | undefined;
  let client: Client | undefined;

  beforeAll(async () => {
    database = await createIsolatedDatabase({
      schemaPrefix: 'slate_harness',
      setup: async (setupClient) => {
        await setupClient.query(SETUP_SQL);
      },
    });
    client = await database.createClient();
  });

  afterAll(async () => {
    if (client !== undefined) {
      await client.end();
    }
    await database?.dispose();
  });

  it('scopes every unqualified statement to the suite schema', async () => {
    const result = await client?.query<{ schema: string | null; path: string }>(
      'SELECT current_schema() AS schema, current_setting($1) AS path',
      ['search_path'],
    );

    expect(result?.rows[0]?.schema).toBe(database?.schema);
    expect(result?.rows[0]?.path).toContain(database?.schema ?? '');
  });

  it('created the fixture inside the isolated schema, not in public', async () => {
    const result = await client?.query<{ isolated: string | null; shared: string | null }>(
      'SELECT to_regclass($1)::text AS isolated, to_regclass($2)::text AS shared',
      ['widgets', 'public.widgets'],
    );

    expect(result?.rows[0]?.isolated).not.toBeNull();
    expect(result?.rows[0]?.shared).toBeNull();
  });

  it('round-trips data and rolls back failed transactions', async () => {
    const inserted = await client?.query<{ id: number; name: string; quantity: number }>(
      'INSERT INTO widgets (name, quantity) VALUES ($1, $2) RETURNING id, name, quantity',
      ['booking-slot', 3],
    );

    expect(inserted?.rows[0]).toMatchObject({ name: 'booking-slot', quantity: 3 });

    await client?.query('BEGIN');
    await client?.query('INSERT INTO widgets (name, quantity) VALUES ($1, $2)', ['rolled-back', 1]);
    await client?.query('ROLLBACK');

    const survived = await client?.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM widgets WHERE name = $1',
      ['rolled-back'],
    );

    expect(survived?.rows[0]?.count).toBe('0');
  });

  it('keeps suites isolated from each other', async () => {
    const other = await createIsolatedDatabase({ schemaPrefix: 'slate_harness_other' });
    const otherClient = await other.createClient();

    try {
      const result = await otherClient.query<{ existing: string | null }>(
        'SELECT to_regclass($1)::text AS existing',
        ['widgets'],
      );

      expect(other.schema).not.toBe(database?.schema);
      expect(result.rows[0]?.existing).toBeNull();
    } finally {
      await otherClient.end();
      await other.dispose();
    }

    // The original fixture is untouched by the teardown of the other suite.
    const stillThere = await client?.query<{ existing: string | null }>(
      'SELECT to_regclass($1)::text AS existing',
      ['widgets'],
    );
    expect(stillThere?.rows[0]?.existing).not.toBeNull();
  });

  it('drops the schema and its objects on dispose', async () => {
    const disposable = await createIsolatedDatabase({ schemaPrefix: 'slate_harness_disposable' });
    const scopedClient = await disposable.createClient();
    await scopedClient.query('CREATE TABLE tickets (id serial PRIMARY KEY)');
    await scopedClient.end();

    await disposable.dispose();
    // Disposing twice must stay safe: teardown errors hide the real failure.
    await dropSchema(requireTestDatabaseUrl(), disposable.schema);

    const inspector = await connectWithSchema(requireTestDatabaseUrl(), 'public');
    try {
      const result = await inspector.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM pg_namespace WHERE nspname = $1',
        [disposable.schema],
      );

      expect(result.rows[0]?.count).toBe('0');
    } finally {
      await inspector.end();
    }
  });
});
