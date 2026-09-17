import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';

import { createLogger, type LogFields } from '@slate/observability';
import { createIsolatedDatabase, integrationEnabled, type IsolatedDatabase } from '@slate/testing';

import { closeDatabase, createDatabase } from './client.ts';
import { runMigrations } from './runner.ts';
import { TenantScopeError, createTenantDatabase, type TenantScopedDatabase } from './tenant.ts';
import type { Database } from './types.ts';

const CORE_TABLES = [
  'organization',
  'tenant',
  'app_user',
  'role',
  'permission',
  'role_permission',
  'tenant_membership',
  'audit_log',
  'system_setting',
  'feature_flag',
] as const;

const MIGRATION_IDS = ['0001', '0002', '0003', '0004', '0005'] as const;

/** A bound parameter that must never reach the log sink in plaintext. */
const SECRET_PARAM = 'postgresql://svc:hunter2secret@db.internal:5432/slate';

describe.skipIf(!integrationEnabled())('@slate/database (integration)', () => {
  let database: IsolatedDatabase | undefined;
  let db: Kysely<Database> | undefined;
  let records: LogFields[] = [];
  let tenantA = '';
  let tenantB = '';
  let scopedA: TenantScopedDatabase | undefined;
  let scopedB: TenantScopedDatabase | undefined;

  beforeAll(async () => {
    database = await createIsolatedDatabase({ schemaPrefix: 'slate_core' });

    records = [];
    const logger = createLogger({
      env: { SLATE_ENV: 'test', LOG_LEVEL: 'debug' },
      sink: (_line, record) => {
        records.push(record);
      },
    });

    // The factory under test, pointed at the suite's own schema.
    const client = createDatabase({
      url: database.url,
      searchPath: database.schema,
      logger,
      env: { SLATE_ENV: 'test' },
    });
    db = client;
    await runMigrations(client);

    const organization = await client
      .insertInto('organization')
      .values({ name: 'Acme Inc', slug: 'acme' })
      .returning('id')
      .executeTakeFirstOrThrow();

    const [tenantARow, tenantBRow] = await client
      .insertInto('tenant')
      .values([
        { organization_id: organization.id, name: 'Tenant A', slug: 'tenant-a' },
        { organization_id: organization.id, name: 'Tenant B', slug: 'tenant-b' },
      ])
      .returning('id')
      .execute();

    if (tenantARow === undefined || tenantBRow === undefined) {
      throw new Error('[slate/database] seeding tenants failed.');
    }
    tenantA = tenantARow.id;
    tenantB = tenantBRow.id;
    scopedA = createTenantDatabase(client, tenantA);
    scopedB = createTenantDatabase(client, tenantB);
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
      throw new Error('[slate/database] integration client is not initialised.');
    }
    return db;
  }

  function scopeFor(tenantId: string): TenantScopedDatabase {
    return createTenantDatabase(client(), tenantId);
  }

  it('applies the Phase 2 migrations and records them in the ledger', async () => {
    const ledger = await client()
      .selectFrom('slate_migrations')
      .select(['id', 'checksum'])
      .orderBy('id')
      .execute();
    expect(ledger.map((row) => row.id)).toEqual(MIGRATION_IDS);
    for (const row of ledger) {
      expect(row.checksum).toMatch(/^[0-9a-f]{64}$/);
    }

    const tables = (await client().introspection.getTables()).map((table) => table.name);
    for (const table of CORE_TABLES) {
      expect(tables).toContain(table);
    }
    expect(tables).toContain('slate_migrations');
  });

  it('is idempotent: a second pass applies nothing and skips everything', async () => {
    const result = await runMigrations(client());
    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual(MIGRATION_IDS);
  });

  it('writes and reads strictly inside the tenant scope', async () => {
    const scoped = scopedA;
    if (scoped === undefined) {
      throw new Error('[slate/database] tenant scopes are not initialised.');
    }

    await scoped
      .insertInto('audit_log', {
        action: 'user.created',
        resource_type: 'app_user',
        payload: { connection: SECRET_PARAM },
      })
      .execute();

    const rowsInScope = await scoped.selectFrom('audit_log').selectAll().execute();
    expect(rowsInScope).toHaveLength(1);
    expect(rowsInScope[0]?.tenant_id).toBe(tenantA);
    expect((rowsInScope[0]?.payload as Record<string, unknown>)['connection']).toBe(SECRET_PARAM);
  });

  it('hides the other tenant from a scoped query', async () => {
    const rows = await scopeFor(tenantB).selectFrom('audit_log').selectAll().execute();
    expect(rows).toHaveLength(0);
  });

  it('rejects an insert that names a foreign tenant', () => {
    const scoped = scopedB;
    if (scoped === undefined) {
      throw new Error('[slate/database] tenant scopes are not initialised.');
    }
    expect(() =>
      scoped.insertInto('audit_log', {
        action: 'user.created',
        payload: {},
        ...({ tenant_id: tenantA } as object),
      }),
    ).toThrow(TenantScopeError);
  });

  it('emits onQuery records at debug and never leaks a secret parameter', () => {
    const queryRecords = records.filter(
      (record) => record.level === 'debug' && record.msg === 'sql query',
    );
    expect(queryRecords.length).toBeGreaterThan(0);
    for (const record of queryRecords) {
      expect(typeof record['sql']).toBe('string');
      expect(Array.isArray(record['parameters'])).toBe(true);
    }

    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain('hunter2secret');
    expect(serialized).toContain('[redacted]');
  });
});
