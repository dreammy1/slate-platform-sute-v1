import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Kysely, sql } from 'kysely';
import { createDatabase, closeDatabase, runMigrations, type Database } from '@slate/database';
import { createIsolatedDatabase, integrationEnabled, type IsolatedDatabase } from '@slate/testing';
import { createLogger } from '@slate/observability';
import { createApi } from './api.ts';
import { createEventBus } from './events.ts';
import { createHttpHandler } from './http.ts';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileSystemStorageProvider, MediaEngine } from '@slate/media';

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
  /** Storage is a required API dependency; these tests use a temp directory. */
  const mediaEngine = new MediaEngine(
    new FileSystemStorageProvider(mkdtempSync(join(tmpdir(), 'slate-media-'))),
    logger,
  );
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
    const api = createApi({ db, logger, events, mediaEngine });
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
    const result = await createApi({ db, logger, events, mediaEngine })({
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
    const api = createApi({ db, logger, events: bus, mediaEngine });
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
      const result = await createApi({ db, logger, events: bus, mediaEngine })({
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
      mediaEngine,
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

describe.skipIf(!integrationEnabled())('search and health (SLATE-208)', () => {
  let isolated: IsolatedDatabase;
  let db: Kysely<Database>;
  let tenantA = '';
  let tenantB = '';
  let adminId = '';
  let memberId = '';
  const logger = createLogger({ env: { SLATE_ENV: 'test' }, sink: () => undefined });
  const mediaEngine = new MediaEngine(
    new FileSystemStorageProvider(mkdtempSync(join(tmpdir(), 'slate-search-'))),
    logger,
  );
  const recordOne = '33333333-3333-4333-8333-333333333333';
  const recordTwo = '44444444-4444-4444-8444-444444444444';

  /** A principal that may act in `tenant` (both tenants for the admin). */
  const principalFor = (userId: string, tenant: string = tenantA) => ({
    userId,
    activeTenantId: tenant,
    tenantIds: tenant === tenantB ? [tenantA, tenantB] : [tenantA],
  });

  beforeAll(async () => {
    isolated = await createIsolatedDatabase({ schemaPrefix: 'slate_search_api' });
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
    const tenants = await db
      .insertInto('tenant')
      .values([
        { organization_id: org.id, name: 'A', slug: 'a' },
        { organization_id: org.id, name: 'B', slug: 'b' },
      ])
      .returning('id')
      .execute();
    tenantA = tenants[0]!.id;
    tenantB = tenants[1]!.id;
    const users = await db
      .insertInto('app_user')
      .values([
        { email: 'search-admin@example.test', display_name: 'Admin', password_hash: '' },
        { email: 'search-member@example.test', display_name: 'Member', password_hash: '' },
      ])
      .returning('id')
      .execute();
    adminId = users[0]!.id;
    memberId = users[1]!.id;

    const adminRole = await db
      .insertInto('role')
      .values({ tenant_id: tenantA, name: 'admin' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('tenant_membership')
      .values({ tenant_id: tenantA, app_user_id: adminId, role_id: adminRole.id })
      .execute();
    await db
      .insertInto('tenant_membership')
      .values({ tenant_id: tenantA, app_user_id: memberId, role_id: null })
      .execute();
    for (const key of ['search.read', 'search.write']) {
      const permission = await db
        .insertInto('permission')
        .values({ tenant_id: tenantA, key })
        .returning('id')
        .executeTakeFirstOrThrow();
      await db
        .insertInto('role_permission')
        .values({ role_id: adminRole.id, permission_id: permission.id })
        .execute();
    }

    // The admin is only a reader in tenant B, which is what the isolation test
    // needs: authorized there, yet unable to see tenant A's documents.
    const readerRole = await db
      .insertInto('role')
      .values({ tenant_id: tenantB, name: 'reader' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('tenant_membership')
      .values({ tenant_id: tenantB, app_user_id: adminId, role_id: readerRole.id })
      .execute();
    const readPermission = await db
      .insertInto('permission')
      .values({ tenant_id: tenantB, key: 'search.read' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('role_permission')
      .values({ role_id: readerRole.id, permission_id: readPermission.id })
      .execute();
  });

  afterAll(async () => {
    if (db) await closeDatabase(db);
    if (isolated) await isolated.dispose();
  });

  const searchAuditCount = async () =>
    (
      await db
        .selectFrom('audit_log')
        .select('id')
        .where('tenant_id', '=', tenantA)
        .where('action', 'like', 'search.%')
        .execute()
    ).length;

  it('indexes a document with exactly one audit row and a post-commit event', async () => {
    const announced: string[] = [];
    const bus = createEventBus(logger);
    bus.subscribe('search.indexed', (payload) => {
      announced.push(payload.entity);
    });
    const api = createApi({ db, logger, events: bus, mediaEngine });

    const response = await api({
      method: 'POST',
      path: '/search/docs.page',
      tenantId: tenantA,
      principal: principalFor(adminId),
      body: {
        recordId: recordOne,
        title: 'Quantum notes',
        body: 'Entanglement and superposition.',
      },
    });
    expect(response.status).toBe(201);
    expect(response.body).toEqual({ entity: 'docs.page', recordId: recordOne });
    expect(announced).toEqual(['docs.page']);

    // The audit row carries the entity and the record id, never the text.
    const audits = await db
      .selectFrom('audit_log')
      .select(['action', 'resource_type', 'payload'])
      .where('tenant_id', '=', tenantA)
      .where('action', '=', 'search.indexed')
      .execute();
    expect(audits).toEqual([
      {
        action: 'search.indexed',
        resource_type: 'search_document',
        payload: { entity: 'docs.page', recordId: recordOne },
      },
    ]);
  });

  it('answers a tenant-scoped ranked query and audits the read', async () => {
    const api = createApi({ db, logger, events: createEventBus(logger), mediaEngine });
    await api({
      method: 'POST',
      path: '/search/docs.page',
      tenantId: tenantA,
      principal: principalFor(adminId),
      body: { recordId: recordTwo, title: 'Alpha beta', body: 'Gamma and delta.' },
    });
    const before = await searchAuditCount();

    const response = await api({
      method: 'GET',
      path: '/search/docs.page',
      tenantId: tenantA,
      principal: principalFor(adminId),
      query: { q: 'quantum', limit: '10' },
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ entity: 'docs.page', query: 'quantum', count: 1 });
    // Every read leaves exactly one attributable audit row.
    expect(await searchAuditCount()).toBe(before + 1);

    // A member without the permission never reaches the index.
    await expect(
      api({
        method: 'GET',
        path: '/search/docs.page',
        tenantId: tenantA,
        principal: principalFor(memberId),
        query: { q: 'quantum' },
      }),
    ).resolves.toEqual({ status: 403, body: { error: 'Request rejected' } });

    // Authorized in tenant B, the same admin still sees nothing of tenant A's.
    expect(
      await api({
        method: 'GET',
        path: '/search/docs.page',
        tenantId: tenantB,
        principal: principalFor(adminId, tenantB),
        query: { q: 'quantum' },
      }),
    ).toMatchObject({ status: 200, body: { count: 0, hits: [] } });
  });

  it('serves the probes without authentication and refuses other verbs', async () => {
    const handler = createHttpHandler({
      db,
      logger,
      events: createEventBus(logger),
      mediaEngine,
      authenticate: async () => undefined,
    });
    const server = createServer((request, response) => {
      void handler(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const live = await fetch(`${base}/health/live`);
      expect(live.status).toBe(200);
      expect(await live.json()).toEqual({ status: 'live' });

      // Trailing slashes are the same probe.
      const liveNormalized = await fetch(`${base}/health/live/`);
      expect(liveNormalized.status).toBe(200);

      const ready = await fetch(`${base}/health/ready`);
      expect(ready.status).toBe(200);
      expect(await ready.json()).toEqual({ status: 'ready' });

      const wrongVerb = await fetch(`${base}/health/ready`, { method: 'POST' });
      expect(wrongVerb.status).toBe(405);
      expect(wrongVerb.headers.get('allow')).toBe('GET');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('answers 503 and no detail when the database is unreachable', async () => {
    const broken = createDatabase({
      url: 'postgresql://slate:broken@127.0.0.1:1/none',
      env: { SLATE_ENV: 'test' },
      logger,
    });
    try {
      const handler = createHttpHandler({
        db: broken,
        logger,
        events: createEventBus(logger),
        mediaEngine,
        authenticate: async () => undefined,
      });
      const server = createServer((request, response) => {
        void handler(request, response);
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('no port');
      try {
        // Liveness stays green: the process is fine, its dependency is not.
        const live = await fetch(`http://127.0.0.1:${address.port}/health/live`);
        expect(live.status).toBe(200);

        const ready = await fetch(`http://127.0.0.1:${address.port}/health/ready`);
        expect(ready.status).toBe(503);
        expect(await ready.json()).toEqual({ status: 'unavailable' });
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    } finally {
      await closeDatabase(broken);
    }
  });
});
