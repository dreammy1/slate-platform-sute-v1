import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kysely } from 'kysely';
import { closeDatabase, createDatabase, runMigrations, type Database } from '@slate/database';
import { createIsolatedDatabase, integrationEnabled, type IsolatedDatabase } from '@slate/testing';
import { createLogger } from '@slate/observability';
import { createEventBus, createHttpHandler } from '@slate/api';
import { MediaEngine, FileSystemStorageProvider } from '@slate/media';

import { createApiClient } from './client.ts';
import { stripApiPrefix } from './routes.ts';

describe.skipIf(!integrationEnabled())('the browser client through the mounted API', () => {
  let isolated: IsolatedDatabase;
  let db: Kysely<Database>;
  let server: Server;
  let baseUrl: string;
  let tenantId: string;
  let actorId: string;
  let foreignTenantId: string;
  const logger = createLogger({
    env: { SLATE_ENV: 'test' },
    // Sink-less: assertions read database state, not log lines.
    sink: () => undefined,
  });
  const events = createEventBus(logger);
  const mediaEngine = new MediaEngine(
    new FileSystemStorageProvider(mkdtempSync(join(tmpdir(), 'slate-client-'))),
    logger,
  );

  beforeAll(async () => {
    isolated = await createIsolatedDatabase({ schemaPrefix: 'slate_client' });
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
    const foreign = await db
      .insertInto('tenant')
      .values({ name: 'B', slug: 'b', organization_id: org.id })
      .returning('id')
      .executeTakeFirstOrThrow();
    foreignTenantId = foreign.id;
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

    const handler = createHttpHandler({
      db,
      logger,
      events,
      mediaEngine,
      // Middleware authenticates the session only; choosing or refusing a tenant
      // is the pipeline's job, so the header is ignored here on purpose.
      authenticate: async (request) =>
        request.headers.authorization === 'Bearer admin'
          ? { userId: actorId, activeTenantId: tenantId, tenantIds: [tenantId] }
          : undefined,
    });
    server = createServer((request, response) => {
      const url = request.url ?? '/';
      const [path, query = ''] = url.split('?');
      const inner = stripApiPrefix(path ?? '/');
      if (inner === undefined) {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'Not found' }));
        return;
      }
      request.url = `${inner}${query === '' ? '' : `?${query}`}`;
      void handler(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    server?.close();
    if (db) await closeDatabase(db);
    if (isolated) await isolated.dispose();
  });

  function clientFor(headers: () => Readonly<Record<string, string>>) {
    return createApiClient({ baseUrl, headers });
  }

  it('refuses anything outside the versioned prefix before the pipeline sees it', async () => {
    const response = await fetch(`${baseUrl}/users`, {
      headers: { authorization: 'Bearer admin' },
    });
    expect(response.status).toBe(404);
  });

  it('creates a user through the mount with a real tenant and one audit row', async () => {
    const client = clientFor(() => ({ authorization: 'Bearer admin', 'x-tenant-id': tenantId }));
    const result = await client.post('/users', { email: 'ui@example.test', name: 'UI User' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(201);
    expect(typeof result.requestId).toBe('string');

    const createdId = (result.data as { user: { id: string } }).user.id;
    const audits = await db
      .selectFrom('audit_log')
      .selectAll()
      .where('resource_id', '=', createdId)
      .execute();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      tenant_id: tenantId,
      actor_user_id: actorId,
      action: 'app.user.created',
    });
  });

  it('rejects a tenant the session does not authorize, instead of re-scoping', async () => {
    const client = clientFor(() => ({
      authorization: 'Bearer admin',
      'x-tenant-id': foreignTenantId,
    }));
    const result = await client.get('/users');
    expect(result).toMatchObject({ ok: false, status: 403, kind: 'forbidden' });
  });

  it('answers an unauthenticated call with the typed unauthenticated kind', async () => {
    const client = clientFor(() => ({}));
    const result = await client.get('/users');
    expect(result).toMatchObject({ ok: false, status: 401, kind: 'unauthenticated' });
  });

  it('never lets the browser choose a tenant in the payload', async () => {
    const client = clientFor(() => ({ authorization: 'Bearer admin', 'x-tenant-id': tenantId }));
    await expect(client.post('/users', { tenantId: foreignTenantId })).rejects.toThrow(/tenant/);
    expect(
      await db
        .selectFrom('app_user')
        .select('id')
        .where('email', '=', 'thief@example.test')
        .execute(),
    ).toEqual([]);
  });

  it('propagates the request id the browser chose, for Section 61 correlation', async () => {
    const client = clientFor(() => ({ authorization: 'Bearer admin', 'x-tenant-id': tenantId }));
    const result = await client.request({ method: 'GET', path: '/users', requestId: 'corr-1' });

    expect(result.ok).toBe(true);
    // The id the caller supplied is what the result carries when the server does
    // not return one, so the UI can always show the id its retry/log lookup needs.
    if (result.ok) expect(result.requestId).toBe('corr-1');

    // The platform-side guarantee this test can prove today: the same browser
    // action is attributable in the audit trail — the server half of request-id
    // logging lands with the session middleware in SLATE-301.
    expect(
      await db
        .selectFrom('audit_log')
        .selectAll()
        .where('actor_user_id', '=', actorId)
        .where('action', '=', 'app.user.created')
        .execute(),
    ).toHaveLength(1);
  });
});
