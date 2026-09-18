import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Kysely, sql } from 'kysely';
import { createDatabase, closeDatabase, runMigrations, type Database } from '@slate/database';
import { createIsolatedDatabase, integrationEnabled, type IsolatedDatabase } from '@slate/testing';
import { createLogger } from '@slate/observability';
import { createApi } from './api.ts';
import { createEventBus } from './events.ts';
import { createHttpHandler } from './http.ts';
import { createServer } from 'node:http';

describe.skipIf(!integrationEnabled())('API transactional user creation', () => {
  let isolated: IsolatedDatabase;
  let db: Kysely<Database>;
  let tenantId: string;
  let actorId: string;
  const logger = createLogger({
    env: { SLATE_ENV: 'test' },
    sink: () => {
      /* test no-op */
    },
  });
  const events = createEventBus(logger);
  beforeAll(async () => {
    isolated = await createIsolatedDatabase({ schemaPrefix: 'slate_api' });
    db = createDatabase({
      url: isolated.url,
      searchPath: isolated.schema,
      env: { SLATE_ENV: 'test' },
      logger,
    });
    await runMigrations(db);
    const org = await db
      .insertInto('organization')
      .values({ name: 'Acme', slug: 'acme' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const tenant = await db
      .insertInto('tenant')
      .values({ name: 'A', slug: 'a', organization_id: org.id })
      .returning('id')
      .executeTakeFirstOrThrow();
    tenantId = tenant.id;
    const actor = await db
      .insertInto('app_user')
      .values({ email: 'admin@example.test', display_name: 'Admin', password_hash: '' })
      .returning('id')
      .executeTakeFirstOrThrow();
    actorId = actor.id;
    const role = await db
      .insertInto('role')
      .values({ tenant_id: tenantId, name: 'admin' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('tenant_membership')
      .values({ tenant_id: tenantId, app_user_id: actorId, role_id: role.id })
      .execute();
    for (const key of ['users.read', 'users.write']) {
      const permission = await db
        .insertInto('permission')
        .values({ tenant_id: tenantId, key })
        .returning('id')
        .executeTakeFirstOrThrow();
      await db
        .insertInto('role_permission')
        .values({ role_id: role.id, permission_id: permission.id })
        .execute();
    }
  });
  afterAll(async () => {
    if (db) await closeDatabase(db);
    if (isolated) await isolated.dispose();
  });
  it('commits the user, tenant membership and exactly one attributed audit before returning 201', async () => {
    const api = createApi({ db, logger, events });
    const response = await api({
      method: 'POST',
      path: '/users',
      tenantId,
      principal: { userId: actorId, activeTenantId: tenantId, tenantIds: [tenantId] },
      body: { email: 'new@example.test', name: 'New User' },
    });
    expect(response.status).toBe(201);
    const user = await db
      .selectFrom('app_user')
      .selectAll()
      .where('email', '=', 'new@example.test')
      .executeTakeFirstOrThrow();
    expect(user.is_active).toBe(false);
    const memberships = await db
      .selectFrom('tenant_membership')
      .selectAll()
      .where('app_user_id', '=', user.id)
      .execute();
    expect(memberships).toHaveLength(1);
    expect(memberships[0]).toMatchObject({ tenant_id: tenantId, role_id: null });
    const audits = await db
      .selectFrom('audit_log')
      .selectAll()
      .where('resource_id', '=', user.id)
      .execute();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      tenant_id: tenantId,
      actor_user_id: actorId,
      action: 'app.user.created',
    });
  });
  it('reads only members of the selected tenant', async () => {
    const org = await db.selectFrom('organization').select('id').executeTakeFirstOrThrow();
    const foreign = await db
      .insertInto('tenant')
      .values({ organization_id: org.id, name: 'B', slug: 'b' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const user = await db
      .insertInto('app_user')
      .values({ email: 'foreign@example.test', display_name: 'Foreign', password_hash: '' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('tenant_membership')
      .values({ tenant_id: foreign.id, app_user_id: user.id, role_id: null })
      .execute();
    const result = await createApi({ db, logger, events })({
      method: 'GET',
      path: '/users',
      tenantId,
      principal: { userId: actorId, activeTenantId: tenantId, tenantIds: [tenantId] },
    });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      users: expect.arrayContaining([expect.objectContaining({ id: actorId })]),
    });
    expect(JSON.stringify(result.body)).not.toContain(user.id);
    expect(JSON.stringify(result.body)).not.toContain('password_hash');
  });

  it('denies an unprivileged member without writing or publishing', async () => {
    const member = await db
      .insertInto('app_user')
      .values({ email: 'member@example.test', display_name: 'Member', password_hash: '' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('tenant_membership')
      .values({ tenant_id: tenantId, app_user_id: member.id, role_id: null })
      .execute();
    const bus = createEventBus(logger);
    const publish = vi.spyOn(bus, 'publish');
    const before = await db.selectFrom('audit_log').selectAll().execute();
    const api = createApi({ db, logger, events: bus });
    for (const method of ['GET', 'POST']) {
      const response = await api({
        method,
        path: '/users',
        tenantId,
        principal: { userId: member.id, activeTenantId: tenantId, tenantIds: [tenantId] },
        body: { email: 'denied@example.test', name: 'Denied' },
      });
      expect(response.status).toBe(403);
    }
    expect(
      await db
        .selectFrom('app_user')
        .select('id')
        .where('email', '=', 'denied@example.test')
        .execute(),
    ).toEqual([]);
    expect(await db.selectFrom('audit_log').selectAll().execute()).toEqual(before);
    expect(publish).not.toHaveBeenCalled();
  });

  it('rolls back user and membership when the mandatory audit insert fails', async () => {
    const bus = createEventBus(logger);
    const publish = vi.spyOn(bus, 'publish');
    const before = await db.selectFrom('tenant_membership').selectAll().orderBy('id').execute();
    // Test-only constraint in this isolated schema: fail the final insert, not the earlier writes.
    await sql`alter table audit_log add constraint test_reject_audit check (action <> 'app.user.created') not valid`.execute(
      db,
    );
    try {
      const result = await createApi({ db, logger, events: bus })({
        method: 'POST',
        path: '/users',
        tenantId,
        principal: { userId: actorId, activeTenantId: tenantId, tenantIds: [tenantId] },
        body: { email: 'rollback@example.test', name: 'Rollback' },
      });
      expect(result).toEqual({ status: 500, body: { error: 'Internal server error' } });
      expect(
        await db
          .selectFrom('app_user')
          .select('id')
          .where('email', '=', 'rollback@example.test')
          .execute(),
      ).toEqual([]);
      expect(await db.selectFrom('tenant_membership').selectAll().orderBy('id').execute()).toEqual(
        before,
      );
      expect(publish).not.toHaveBeenCalled();
    } finally {
      await sql`alter table audit_log drop constraint test_reject_audit`.execute(db);
    }
  });

  it('serves the HTTP adapter end to end: authorized write, audited event, denied read', async () => {
    const bus = createEventBus(logger);
    const delivered: { name: string; tenantId: string }[] = [];
    bus.subscribe('app.user.created', (payload) => {
      delivered.push({ name: 'app.user.created', tenantId: payload.tenantId });
    });
    bus.subscribe('app.audit.recorded', (payload) => {
      delivered.push({ name: 'app.audit.recorded', tenantId: payload.tenantId });
    });
    const handler = createHttpHandler({
      db,
      logger,
      events: bus,
      authenticate: async (request) =>
        request.headers.authorization === 'Bearer admin'
          ? { userId: actorId, activeTenantId: tenantId, tenantIds: [tenantId] }
          : undefined,
    });
    const server = createServer((request, response) => {
      void handler(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const created = await fetch(`${base}/users`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer admin',
          'content-type': 'application/json',
          'x-tenant-id': tenantId,
        },
        body: JSON.stringify({ email: 'http@example.test', name: 'Http User' }),
      });
      expect(created.status).toBe(201);
      expect(created.headers.get('x-content-type-options')).toBe('nosniff');

      const read = await fetch(`${base}/users`, {
        headers: { authorization: 'Bearer admin', 'x-tenant-id': tenantId },
      });
      expect(read.status).toBe(200);
      expect(JSON.stringify(await read.json())).toContain('http@example.test');

      // An unauthenticated request is rejected before any query or event.
      const anonymous = await fetch(`${base}/users`, { headers: { 'x-tenant-id': tenantId } });
      expect(anonymous.status).toBe(401);

      expect(delivered).toEqual([
        { name: 'app.user.created', tenantId },
        { name: 'app.audit.recorded', tenantId },
      ]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
