/**
 * SLATE-302 integration suite: the admin modules against real PostgreSQL.
 *
 * Proves the properties ADR 010 commits to: tenant isolation (a non-member
 * tenant is refused, never re-scoped), exactly one attributable audit row per
 * write, the escalation guard (an actor cannot grant what it does not hold), and
 * per-tenant feature-flag overrides that resolve override over default.
 */

import { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeDatabase, createDatabase, runMigrations, type Database } from '@slate/database';
import { createLogger } from '@slate/observability';
import { FEATURE_FLAG_KEYS } from '@slate/settings';
import { createIsolatedDatabase, integrationEnabled, type IsolatedDatabase } from '@slate/testing';

import { createFlagAdminService } from './flags.ts';
import { collectHealthSnapshot } from './health.ts';
import { AdminEscalationError, type AdminActor } from './permissions.ts';
import { createTenantAdminService } from './tenants.ts';
import { createUserAdminService } from './users.ts';

const logger = createLogger({ env: { SLATE_ENV: 'test' }, sink: () => undefined });

/** Reads an inserted id, refusing to guess when the fixture is incomplete. */
function requiredId(ids: ReadonlyMap<string, string>, key: string): string {
  const id = ids.get(key);
  if (id === undefined) throw new Error(`[fixture] missing permission "${key}"`);
  return id;
}

describe.skipIf(!integrationEnabled())('admin feature modules against PostgreSQL', () => {
  let isolated: IsolatedDatabase;
  let db: Kysely<Database>;
  let tenantA: string;
  let tenantB: string;
  let operatorId: string;
  let memberId: string;
  let viewerRoleId: string;
  let bossRoleId: string;
  let operator: AdminActor;
  let flagKey: string;

  beforeAll(async () => {
    isolated = await createIsolatedDatabase({ schemaPrefix: 'slate_admin' });
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
    tenantA = (
      await db
        .insertInto('tenant')
        .values({ name: 'Alpha', slug: 'alpha', organization_id: org.id })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    tenantB = (
      await db
        .insertInto('tenant')
        .values({ name: 'Beta', slug: 'beta', organization_id: org.id })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;

    async function addUser(email: string, name: string): Promise<string> {
      const row = await db
        .insertInto('app_user')
        .values({ email, display_name: name, password_hash: '' })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    }

    operatorId = await addUser('operator@example.test', 'Operator');
    memberId = await addUser('member@example.test', 'Member');
    const outsiderId = await addUser('outsider@example.test', 'Outsider');

    const permissionIds = new Map<string, string>();
    for (const key of [
      'users.read',
      'roles.manage',
      'settings.read',
      'settings.manage',
      'tenants.read',
      'tenants.manage',
    ]) {
      const row = await db
        .insertInto('permission')
        .values({ tenant_id: tenantA, key })
        .returning('id')
        .executeTakeFirstOrThrow();
      permissionIds.set(key, row.id);
    }

    async function addRole(
      name: string,
      description: string,
      keys: readonly string[],
    ): Promise<string> {
      const role = await db
        .insertInto('role')
        .values({ tenant_id: tenantA, name, description })
        .returning('id')
        .executeTakeFirstOrThrow();
      for (const key of keys) {
        await db
          .insertInto('role_permission')
          .values({ role_id: role.id, permission_id: requiredId(permissionIds, key) })
          .execute();
      }
      return role.id;
    }

    viewerRoleId = await addRole('viewer', 'Read users', ['users.read']);
    bossRoleId = await addRole('boss', 'Owns configuration', ['settings.manage', 'users.read']);

    await db
      .insertInto('tenant_membership')
      .values({ tenant_id: tenantA, app_user_id: operatorId, role_id: bossRoleId })
      .execute();
    await db
      .insertInto('tenant_membership')
      .values({ tenant_id: tenantA, app_user_id: memberId, role_id: viewerRoleId })
      .execute();
    await db
      .insertInto('tenant_membership')
      .values({ tenant_id: tenantB, app_user_id: outsiderId, role_id: null })
      .execute();

    // The operator holds administrative keys but deliberately NOT settings.manage,
    // so the `boss` role is a genuine escalation target for it.
    operator = {
      userId: operatorId,
      tenantId: tenantA,
      permissions: [
        'users.read',
        'roles.manage',
        'settings.read',
        'tenants.read',
        'tenants.manage',
      ],
    };
    flagKey = FEATURE_FLAG_KEYS[0] ?? 'undeclared.flag';
  });

  afterAll(async () => {
    if (db) await closeDatabase(db);
    if (isolated) await isolated.dispose();
  });

  async function auditRows(tenantId: string, action: string) {
    return db
      .selectFrom('audit_log')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('action', '=', action)
      .execute();
  }

  async function membershipRole(userId: string): Promise<string | null> {
    const row = await db
      .selectFrom('tenant_membership')
      .select('role_id')
      .where('app_user_id', '=', userId)
      .where('tenant_id', '=', tenantA)
      .executeTakeFirstOrThrow();
    return row.role_id;
  }

  it('lists only the tenants the actor is a member of', async () => {
    const tenants = createTenantAdminService(db);
    const rows = await tenants.listTenants(operator);
    expect(rows.map((row) => row.id)).toEqual([tenantA]);
    expect(rows[0]?.name).toBe('Alpha');
    expect(rows[0]?.memberCount).toBe(2);
  });

  it('refuses a tenant outside the actor memberships instead of re-scoping', async () => {
    const tenants = createTenantAdminService(db);
    await expect(tenants.getTenantDetail(operator, tenantB)).rejects.toThrow(/not found/i);
    const detail = await tenants.getTenantDetail(operator, tenantA);
    expect(detail.members.map((member) => member.email)).toEqual([
      'member@example.test',
      'operator@example.test',
    ]);
  });

  it('creates a tenant in the actor organization and audits it exactly once', async () => {
    const tenants = createTenantAdminService(db);
    const before = await auditRows(tenantA, 'admin.tenant.created');
    const created = await tenants.createTenant(operator, { name: 'Gamma', slug: 'gamma' });
    expect(created.organizationName).toBe('Acme');
    expect(created.memberCount).toBe(0);

    const after = await auditRows(tenantA, 'admin.tenant.created');
    expect(after).toHaveLength(before.length + 1);
    expect(after.at(-1)).toMatchObject({
      actor_user_id: operatorId,
      resource_type: 'tenant',
      resource_id: created.id,
    });
    // Creating a tenant does not silently make the actor a member of it.
    const rows = await tenants.listTenants(operator);
    expect(rows.map((row) => row.id)).toEqual([tenantA]);
  });

  it('refuses an invalid slug and a missing permission without writing', async () => {
    const tenants = createTenantAdminService(db);
    const before = await auditRows(tenantA, 'admin.tenant.created');
    await expect(
      tenants.createTenant(operator, { name: 'Bad', slug: 'Not A Slug' }),
    ).rejects.toThrow(/slug/i);
    const weak: AdminActor = { ...operator, permissions: ['tenants.read'] };
    await expect(tenants.createTenant(weak, { name: 'Nope', slug: 'nope' })).rejects.toThrow(
      /does not hold/i,
    );
    expect(await auditRows(tenantA, 'admin.tenant.created')).toHaveLength(before.length);
  });

  it('lists users and roles scoped to the active tenant', async () => {
    const users = createUserAdminService(db);
    const members = await users.listUsers(operator);
    expect(members.map((member) => member.email)).toEqual([
      'member@example.test',
      'operator@example.test',
    ]);
    const roles = await users.listRoles(operator);
    const viewer = roles.find((role) => role.id === viewerRoleId);
    expect(viewer?.permissionKeys).toEqual(['users.read']);
  });

  it('assigns a role within the actor authority, with one attributable audit row', async () => {
    const users = createUserAdminService(db);
    const before = await auditRows(tenantA, 'admin.user.role-assigned');
    await users.assignRole(operator, { userId: memberId, roleId: viewerRoleId });
    expect(await membershipRole(memberId)).toBe(viewerRoleId);

    const after = await auditRows(tenantA, 'admin.user.role-assigned');
    expect(after).toHaveLength(before.length + 1);
    expect(after.at(-1)).toMatchObject({ actor_user_id: operatorId, resource_id: memberId });
  });

  it('refuses an escalating role assignment and changes nothing', async () => {
    const users = createUserAdminService(db);
    const before = await auditRows(tenantA, 'admin.user.role-assigned');
    await expect(
      users.assignRole(operator, { userId: memberId, roleId: bossRoleId }),
    ).rejects.toBeInstanceOf(AdminEscalationError);
    // The membership keeps its earlier, in-authority role and no audit row is
    // written for the refused escalation.
    expect(await membershipRole(memberId)).toBe(viewerRoleId);
    expect(await auditRows(tenantA, 'admin.user.role-assigned')).toHaveLength(before.length);
  });

  it('refuses a role from another tenant as not-found', async () => {
    const users = createUserAdminService(db);
    await expect(
      users.assignRole(operator, {
        userId: memberId,
        roleId: '00000000-0000-0000-0000-000000000000',
      }),
    ).rejects.toThrow(/not found/i);
  });

  it('sets and clears a per-tenant flag override, reporting the source', async () => {
    const flags = createFlagAdminService(db);
    const flagAdmin: AdminActor = {
      ...operator,
      permissions: ['settings.read', 'settings.manage'],
    };

    const initial = await flags.panel(flagAdmin);
    expect(initial.find((entry) => entry.key === flagKey)?.source).toBe('registry-default');

    const before = await auditRows(tenantA, 'admin.feature-flag.changed');
    const set = await flags.setOverride(flagAdmin, { key: flagKey, enabled: 'true' });
    expect(set).toMatchObject({ key: flagKey, enabled: true, source: 'override' });

    const panel = await flags.panel(flagAdmin);
    expect(panel.find((entry) => entry.key === flagKey)).toMatchObject({
      enabled: true,
      source: 'override',
    });

    // The override is confined to the acting tenant.
    expect(
      await db.selectFrom('feature_flag').selectAll().where('tenant_id', '=', tenantB).execute(),
    ).toEqual([]);

    const cleared = await flags.setOverride(flagAdmin, { key: flagKey, enabled: 'default' });
    expect(cleared.source).toBe('registry-default');

    const after = await auditRows(tenantA, 'admin.feature-flag.changed');
    expect(after).toHaveLength(before.length + 2);
    expect(after.at(-1)).toMatchObject({ actor_user_id: operatorId, resource_id: flagKey });
  });

  it('refuses an unknown flag key and a flag write without the permission', async () => {
    const flags = createFlagAdminService(db);
    const flagAdmin: AdminActor = {
      ...operator,
      permissions: ['settings.read', 'settings.manage'],
    };
    await expect(
      flags.setOverride(flagAdmin, { key: 'not.a.flag', enabled: 'true' }),
    ).rejects.toThrow();
    await expect(flags.setOverride(operator, { key: flagKey, enabled: 'true' })).rejects.toThrow(
      /does not hold/i,
    );
  });

  it('projects the health probes to a sanitized healthy snapshot', async () => {
    const snapshot = await collectHealthSnapshot(db, () => new Date('2026-09-20T00:00:00.000Z'));
    expect(snapshot.status).toBe('healthy');
    expect(snapshot.probes.map((probe) => probe.state)).toEqual(['healthy', 'healthy']);
    expect(snapshot.checkedAt).toBe('2026-09-20T00:00:00.000Z');
  });
});
