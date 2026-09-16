import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';

import { closeDatabase, createDatabase, runMigrations, type Database } from '@slate/database';
import { createIsolatedDatabase, integrationEnabled, type IsolatedDatabase } from '@slate/testing';

import { getCurrentUser } from './index.ts';

describe.skipIf(!integrationEnabled())('@slate/auth getCurrentUser (integration)', () => {
  let database: IsolatedDatabase | undefined;
  let db: Kysely<Database> | undefined;
  let aliceId = '';
  let inactiveId = '';

  beforeAll(async () => {
    database = await createIsolatedDatabase({ schemaPrefix: 'slate_auth_user' });
    const client = createDatabase({
      url: database.url,
      searchPath: database.schema,
      env: { SLATE_ENV: 'test' },
    });
    db = client;
    await runMigrations(client);

    const [aliceRow, carolRow] = await client
      .insertInto('app_user')
      .values([
        { email: 'alice@example.com', display_name: 'Alice', password_hash: 'stub' },
        { email: 'carol@example.com', display_name: 'Carol', password_hash: 'stub' },
      ])
      .returning('id')
      .execute();
    if (aliceRow === undefined || carolRow === undefined) {
      throw new Error('[slate/auth] seeding users failed.');
    }
    aliceId = aliceRow.id;
    inactiveId = carolRow.id;
    await client
      .updateTable('app_user')
      .set({ is_active: false })
      .where('id', '=', inactiveId)
      .execute();
  });

  afterAll(async () => {
    if (db !== undefined) {
      await closeDatabase(db);
      db = undefined;
    }
    if (database !== undefined) {
      await database.dispose();
      database = undefined;
    }
  });

  function client(): Kysely<Database> {
    if (db === undefined) {
      throw new Error('[slate/auth] integration client is not initialised.');
    }
    return db;
  }

  it('resolves the user for a server-derived id', async () => {
    const user = await getCurrentUser(client(), aliceId);
    expect(user).toMatchObject({ id: aliceId, email: 'alice@example.com', status: 'active' });
  });

  it('returns null for unknown and inactive users', async () => {
    const missing = await getCurrentUser(client(), '00000000-0000-4000-8000-000000000000');
    expect(missing).toBeNull();
    const inactive = await getCurrentUser(client(), inactiveId);
    expect(inactive).toBeNull();
  });
});
