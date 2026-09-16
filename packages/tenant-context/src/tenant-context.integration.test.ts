import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';

import { createLogger, type LogFields, type Logger } from '@slate/observability';
import { createIsolatedDatabase, integrationEnabled, type IsolatedDatabase } from '@slate/testing';

import { closeDatabase, createDatabase, runMigrations, type Database } from '@slate/database';

import {
  assertTenantContext,
  createRequestDatabase,
  emitTenantSelected,
  resolveTenantContext,
  resolveTenantOrganization,
  tenantDatabaseFor,
  TenantContextError,
} from './index.ts';

describe.skipIf(!integrationEnabled())('@slate/tenant-context (integration)', () => {
  let database: IsolatedDatabase | undefined;
  let db: Kysely<Database> | undefined;
  let records: LogFields[] = [];
  let logger: Logger | undefined;
  let organizationId = '';
  let tenantA = '';
  let tenantB = '';
  let aliceId = '';

  beforeAll(async () => {
    database = await createIsolatedDatabase({ schemaPrefix: 'slate_tenant_ctx' });

    records = [];
    logger = createLogger({
      env: { SLATE_ENV: 'test', LOG_LEVEL: 'debug' },
      sink: (_line, record) => {
        records.push(record);
      },
    });

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
    organizationId = organization.id;

    const [tenantARow, tenantBRow] = await client
      .insertInto('tenant')
      .values([
        { organization_id: organizationId, name: 'Tenant A', slug: 'tenant-a' },
        { organization_id: organizationId, name: 'Tenant B', slug: 'tenant-b' },
      ])
      .returning('id')
      .execute();
    if (tenantARow === undefined || tenantBRow === undefined) {
      throw new Error('[slate/tenant-context] seeding tenants failed.');
    }
    tenantA = tenantARow.id;
    tenantB = tenantBRow.id;

    const [aliceRow, bobRow] = await client
      .insertInto('app_user')
      .values([
        // password_hash stays a stub until the SLATE-202 security ADR.
        { email: 'alice@example.com', display_name: 'Alice', password_hash: 'stub' },
        { email: 'bob@example.com', display_name: 'Bob', password_hash: 'stub' },
      ])
      .returning('id')
      .execute();
    if (aliceRow === undefined || bobRow === undefined) {
      throw new Error('[slate/tenant-context] seeding users failed.');
    }
    aliceId = aliceRow.id;

    // Alice belongs to tenant A only; Bob to tenant B only.
    await client
      .insertInto('tenant_membership')
      .values([
        { tenant_id: tenantA, app_user_id: aliceId },
        { tenant_id: tenantB, app_user_id: bobRow.id },
      ])
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
      throw new Error('[slate/tenant-context] integration client is not initialised.');
    }
    return db;
  }

  function eventLogger(): Logger {
    if (logger === undefined) {
      throw new Error('[slate/tenant-context] integration logger is not initialised.');
    }
    return logger;
  }

  function countQueryRecords(log: readonly LogFields[]): number {
    return log.filter((record) => record.level === 'debug' && record.msg === 'sql query').length;
  }

  it('resolves the tenant context from an authorized X-Tenant-Id header', () => {
    const principal = { userId: aliceId, tenantIds: [tenantA, tenantB] };
    const context = assertTenantContext({ principal, requestedTenantId: tenantA });
    expect(context.tenantId).toBe(tenantA);
  });

  it('defaults to the session active tenant and rejects a foreign header with 403', () => {
    const principal = { userId: aliceId, tenantIds: [tenantA], activeTenantId: tenantA };

    // No header: the session-bound tenant is used.
    expect(assertTenantContext({ principal, requestedTenantId: undefined })).toEqual({
      tenantId: tenantA,
    });

    // Header repeating the session tenant is accepted.
    expect(assertTenantContext({ principal, requestedTenantId: tenantA })).toEqual({
      tenantId: tenantA,
    });

    // Section 65 adversarial case: header names another tenant -> 403.
    const result = resolveTenantContext({ principal, requestedTenantId: tenantB });
    expect(result).toEqual({
      ok: false,
      status: 403,
      reason: expect.stringMatching(/bound to a different tenant/),
    });
    expect(() => assertTenantContext({ principal, requestedTenantId: tenantB })).toThrow(
      TenantContextError,
    );
  });

  it('rejects a foreign X-Tenant-Id with 403 before any query is issued', () => {
    const queriesBefore = countQueryRecords(records);

    // Alice is authenticated but only authorized for tenant A.
    const principal = { userId: aliceId, tenantIds: [tenantA] };
    const result = resolveTenantContext({ principal, requestedTenantId: tenantB });

    expect(result).toEqual({
      ok: false,
      status: 403,
      reason: expect.stringMatching(/not authorized/),
    });
    expect(() => assertTenantContext({ principal, requestedTenantId: tenantB })).toThrow(
      TenantContextError,
    );

    // The rejection happened at the context layer: no query was issued for it.
    expect(countQueryRecords(records)).toBe(queriesBefore);
  });

  it('isolates tenants: rows written for A are invisible to the B scope', async () => {
    const scopedA = tenantDatabaseFor(client(), { tenantId: tenantA });
    const scopedB = tenantDatabaseFor(client(), { tenantId: tenantB });

    await scopedA
      .insertInto('audit_log', { action: 'user.created', payload: { via: 'scope A' } })
      .execute();

    // Alice's membership (tenant A) is the only membership Alice can see.
    const membershipsA = await scopedA.selectFrom('tenant_membership').selectAll().execute();
    expect(membershipsA.map((row) => row.tenant_id)).toEqual([tenantA]);

    // The same table through tenant B's scope: tenant A's rows do not exist.
    const membershipsB = await scopedB.selectFrom('tenant_membership').selectAll().execute();
    expect(membershipsB.map((row) => row.app_user_id)).not.toContain(aliceId);
    expect(await scopedB.selectFrom('audit_log').selectAll().execute()).toHaveLength(0);

    // And the tenant scoping holds per tenant, not per user:
    const auditRowsForA = await scopedA.selectFrom('audit_log').selectAll().execute();
    expect(auditRowsForA).toHaveLength(1);
    expect(auditRowsForA[0]?.tenant_id).toBe(tenantA);
  });

  it('resolves the owning organization for a tenant', async () => {
    const organization = await resolveTenantOrganization(client(), tenantA);
    expect(organization).toMatchObject({
      tenantId: tenantA,
      tenantSlug: 'tenant-a',
      organizationId,
      organizationSlug: 'acme',
      organizationName: 'Acme Inc',
    });

    const alsoForB = await resolveTenantOrganization(client(), tenantB);
    expect(alsoForB.organizationId).toBe(organizationId);
  });

  it('fails loudly when a tenant has no owning organization', async () => {
    const unknown = '99999999-9999-4999-8999-999999999999';
    await expect(resolveTenantOrganization(client(), unknown)).rejects.toThrow(
      /no owning organization row/,
    );
  });

  it('emits tenant.selected with tenantId and organizationId through the logger', () => {
    const eventsBefore = records.filter((record) => record['event'] === 'tenant.selected').length;

    emitTenantSelected(eventLogger(), {
      tenantId: tenantA,
      organizationId,
      requestId: 'req-integration-1',
    });

    const events = records.filter((record) => record['event'] === 'tenant.selected');
    expect(events).toHaveLength(eventsBefore + 1);
    const record = events.at(-1) as LogFields;
    expect(record.level).toBe('info');
    expect(record['tenantId']).toBe(tenantA);
    expect(record['organizationId']).toBe(organizationId);
    expect(record['requestId']).toBe('req-integration-1');
  });

  it('pins the request search_path and binds the tenant to query logs', async () => {
    const requestRecords: LogFields[] = [];
    const requestLogger = createLogger({
      env: { SLATE_ENV: 'test', LOG_LEVEL: 'debug' },
      sink: (_line, record) => {
        requestRecords.push(record);
      },
    });

    const requestDb = createRequestDatabase({
      url: database?.url ?? '',
      schema: database?.schema ?? '',
      context: { tenantId: tenantA },
      requestId: 'req-integration-2',
      logger: requestLogger,
      env: { SLATE_ENV: 'test' },
    });

    try {
      // Unqualified identifiers resolve inside the request's search_path only
      // (this suite's schema, not `public`): both seeded tenants are visible
      // there - row-level isolation is the scoped helper's job, not the schema's.
      const rows = await requestDb.selectFrom('tenant').selectAll().orderBy('slug').execute();
      expect(rows.map((row) => row.slug)).toEqual(['tenant-a', 'tenant-b']);

      const queryRecords = requestRecords.filter(
        (record) => record.level === 'debug' && record.msg === 'sql query',
      );
      expect(queryRecords.length).toBeGreaterThan(0);
      for (const record of queryRecords) {
        expect(record['tenantId']).toBe(tenantA);
        expect(record['requestId']).toBe('req-integration-2');
      }
    } finally {
      await closeDatabase(requestDb);
    }
  });
});
