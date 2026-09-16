import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';

import { closeDatabase, createDatabase, runMigrations, type Database } from '@slate/database';
import { createIsolatedDatabase, integrationEnabled, type IsolatedDatabase } from '@slate/testing';

import { createAuth, createAuthQueryService, createPermissionEvaluator } from './index.ts';
import { PermissionAuthorizationError } from './permissions/errors.ts';

describe.skipIf(!integrationEnabled())('@slate/auth permissions (integration)', () => {
  let database: IsolatedDatabase | undefined;
  let db: Kysely<Database> | undefined;
  let tenantA = '';
  let tenantB = '';
  let aliceId = '';
  let bobId = '';
  let adminRoleA = '';

  beforeAll(async () => {
    database = await createIsolatedDatabase({ schemaPrefix: 'slate_auth_perm' });
    const client = createDatabase({
      url: database.url,
      searchPath: database.schema,
      env: { SLATE_ENV: 'test' },
    });
    db = client;
    await runMigrations(client);

    const organization = await client
      .insertInto('organization')
      .values({ name: 'Acme Inc', slug: 'acme' })
      .returning('id')
      .executeTakeFirstOrThrow();

    const tenants = await client
      .insertInto('tenant')
      .values([
        { organization_id: organization.id, name: 'Tenant A', slug: 'tenant-a' },
        { organization_id: organization.id, name: 'Tenant B', slug: 'tenant-b' },
      ])
      .returning('id')
      .execute();
    const tenantARow = tenants[0];
    const tenantBRow = tenants[1];
    if (tenantARow === undefined || tenantBRow === undefined) {
      throw new Error('[slate/auth] seeding tenants failed.');
    }
    tenantA = tenantARow.id;
    tenantB = tenantBRow.id;

    const users = await client
      .insertInto('app_user')
      .values([
        { email: 'alice@example.com', display_name: 'Alice', password_hash: 'stub' },
        { email: 'bob@example.com', display_name: 'Bob', password_hash: 'stub' },
      ])
      .returning('id')
      .execute();
    const aliceRow = users[0];
    const bobRow = users[1];
    if (aliceRow === undefined || bobRow === undefined) {
      throw new Error('[slate/auth] seeding users failed.');
    }
    aliceId = aliceRow.id;
    bobId = bobRow.id;

    const roles = await client
      .insertInto('role')
      .values([
        { tenant_id: tenantA, name: 'admin', description: 'Tenant A admins' },
        { tenant_id: tenantA, name: 'viewer', description: 'Tenant A viewers' },
        { tenant_id: tenantB, name: 'admin', description: 'Tenant B admins' },
      ])
      .returning('id')
      .execute();
    const adminARow = roles[0];
    const viewerARow = roles[1];
    const adminBRow = roles[2];
    if (adminARow === undefined || viewerARow === undefined || adminBRow === undefined) {
      throw new Error('[slate/auth] seeding roles failed.');
    }
    adminRoleA = adminARow.id;

    const permissions = await client
      .insertInto('permission')
      .values([
        { tenant_id: tenantA, key: 'users.read', description: 'Read users' },
        { tenant_id: tenantA, key: 'users.write', description: 'Write users' },
        { tenant_id: tenantB, key: 'billing.refund', description: 'Refund billing' },
      ])
      .returning(['id', 'key'])
      .execute();
    const permissionId = (key: string): string => {
      const row = permissions.find((candidate) => candidate.key === key);
      if (row === undefined) {
        throw new Error(`[slate/auth] seeding permission ${key} failed.`);
      }
      return row.id;
    };

    await client
      .insertInto('role_permission')
      .values([
        { role_id: adminARow.id, permission_id: permissionId('users.read') },
        { role_id: adminARow.id, permission_id: permissionId('users.write') },
        { role_id: viewerARow.id, permission_id: permissionId('users.read') },
        { role_id: adminBRow.id, permission_id: permissionId('billing.refund') },
      ])
      .execute();

    await client
      .insertInto('tenant_membership')
      .values([
        { tenant_id: tenantA, app_user_id: aliceId, role_id: adminARow.id },
        { tenant_id: tenantB, app_user_id: aliceId, role_id: adminBRow.id },
        { tenant_id: tenantA, app_user_id: bobId, role_id: viewerARow.id },
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
      throw new Error('[slate/auth] integration client is not initialised.');
    }
    return db;
  }

  it('a tenant’s users cannot see another tenant’s permissions', async () => {
    const service = createAuthQueryService(client());
    await expect(service.getPermissionsForUser(aliceId, tenantA)).resolves.toEqual([
      'users.read',
      'users.write',
    ]);
    await expect(service.getPermissionsForUser(aliceId, tenantB)).resolves.toEqual([
      'billing.refund',
    ]);
    await expect(service.getPermissionsForUser(bobId, tenantA)).resolves.toEqual(['users.read']);
    await expect(service.getPermissionsForUser(bobId, tenantB)).resolves.toEqual([]);
  });

  it('wires user resolution, permission checks, ownership and denial through createAuth', async () => {
    const auth = createAuth(client());
    await expect(auth.getCurrentUser(aliceId)).resolves.toMatchObject({ id: aliceId });
    await expect(
      auth.hasPermission({
        userId: aliceId,
        tenantId: tenantA,
        permission: 'users.read',
      }),
    ).resolves.toBe(true);
    await expect(
      auth.hasPermission({
        userId: bobId,
        tenantId: tenantB,
        permission: 'billing.refund',
      }),
    ).resolves.toBe(false);
    await expect(
      auth.evaluator.assertPermission({
        userId: bobId,
        tenantId: tenantA,
        permission: 'users.write',
      }),
    ).rejects.toBeInstanceOf(PermissionAuthorizationError);
    await expect(
      auth.hasPermission({
        userId: aliceId,
        tenantId: tenantA,
        permission: 'document.read',
        ownership: {
          resourceType: 'document',
          resourceId: 'owned-document',
          policy: {
            getOwnerPermissions: (check) =>
              check.userId === aliceId &&
              check.tenantId === tenantA &&
              check.resourceId === 'owned-document'
                ? ['document.read']
                : null,
          },
        },
      }),
    ).resolves.toBe(true);
  });

  it('observes a committed permission revocation on the next check (Section 65)', async () => {
    const evaluator = createPermissionEvaluator({ queryService: createAuthQueryService(client()) });
    const params = { userId: aliceId, tenantId: tenantA, permission: 'users.write' };
    const permission = await client()
      .selectFrom('permission')
      .select('id')
      .where('tenant_id', '=', tenantA)
      .where('key', '=', params.permission)
      .executeTakeFirstOrThrow();
    await expect(evaluator.hasPermission(params)).resolves.toBe(true);
    try {
      await client()
        .deleteFrom('role_permission')
        .where('role_id', '=', adminRoleA)
        .where('permission_id', '=', permission.id)
        .execute();
      await expect(evaluator.hasPermission(params)).resolves.toBe(false);
      await expect(evaluator.assertPermission(params)).rejects.toBeInstanceOf(
        PermissionAuthorizationError,
      );
      await expect(evaluator.hasPermission({ ...params, permission: 'users.read' })).resolves.toBe(
        true,
      );
    } finally {
      await client()
        .insertInto('role_permission')
        .values({ role_id: adminRoleA, permission_id: permission.id })
        .execute();
    }
  });
});
