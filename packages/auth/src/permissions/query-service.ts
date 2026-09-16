/**
 * Permission query service: the database-facing half of the authorization
 * spine (SLATE-202).
 *
 * One Kysely join chain, used by every permission check:
 *
 *   tenant_membership (tenant_id, app_user_id, role_id)
 *     -> role_permission (role_id -> permission_id)
 *     -> permission (tenant_id, key)
 *
 * Both `tenant_membership.tenant_id` and `permission.tenant_id` are pinned to
 * the requested tenant, so cross-tenant permission leakage is structurally
 * impossible: the query can only ever return keys that belong to the tenant
 * named in the predicate.
 *
 * No caching anywhere in this module. Every call re-queries the database, so
 * a role's permission revoked mid-session is reflected immediately (Master
 * Plan Section 65). Fakes implementing {@link PermissionQueryService} are the
 * unit-test seam: the evaluator depends on this interface, never on Kysely.
 */

import type { Kysely } from 'kysely';

import type { Database } from '@slate/database';

import type { TenantId, UserId } from '../types.ts';

const ERROR_PREFIX = '[slate/auth]';

/**
 * The join-chain contract the evaluator consumes.
 *
 * `getPermissionsForUser` returns the distinct, sorted permission *keys* (not
 * ids) for a user in a tenant. `findPermission` resolves one tenant-scoped
 * permission key to its row id, or `null` when it does not exist.
 */
export interface PermissionQueryService {
  getPermissionsForUser(userId: UserId, tenantId: TenantId): Promise<readonly string[]>;
  findPermission(tenantId: TenantId, key: string): Promise<{ id: string } | null>;
}

/**
 * Narrower surface re-exported for callers that only need reads.
 *
 * The evaluator accepts the full {@link PermissionQueryService}; this alias
 * exists so route layers can depend on the read side without importing the
 * write-capable factory.
 */
export type ReadablePermissionQueryService = Pick<
  PermissionQueryService,
  'getPermissionsForUser' | 'findPermission'
>;

/**
 * Builds a {@link PermissionQueryService} backed by a real Kysely<Database>.
 *
 * @param db - the database client to query. Pass a tenant-scoped client in
 *   production; the predicates below pin the tenant explicitly regardless.
 */
export function createPermissionQueryService(db: Kysely<Database>): PermissionQueryService {
  return { getPermissionsForUser, findPermission };

  async function getPermissionsForUser(
    userId: UserId,
    tenantId: TenantId,
  ): Promise<readonly string[]> {
    assertServerId(userId, 'userId');
    assertServerId(tenantId, 'tenantId');

    // Fresh query on every call: no cache, no memoization (Section 65).
    const rows = await db
      .selectFrom('tenant_membership')
      .innerJoin('role_permission', 'role_permission.role_id', 'tenant_membership.role_id')
      .innerJoin('permission', 'permission.id', 'role_permission.permission_id')
      .where('tenant_membership.tenant_id', '=', tenantId)
      .where('tenant_membership.app_user_id', '=', userId)
      .where('permission.tenant_id', '=', tenantId)
      .select('permission.key as key')
      .distinct()
      .execute();

    return rows.map((row) => row.key).sort();
  }

  async function findPermission(tenantId: TenantId, key: string): Promise<{ id: string } | null> {
    assertServerId(tenantId, 'tenantId');
    if (typeof key !== 'string' || key.trim() === '') {
      throw new Error(`${ERROR_PREFIX} permission key must be a non-empty string.`);
    }

    const row = await db
      .selectFrom('permission')
      .where('permission.tenant_id', '=', tenantId)
      .where('permission.key', '=', key)
      .select('permission.id as id')
      .limit(1)
      .executeTakeFirst();

    return row === undefined ? null : { id: row.id };
  }
}

function assertServerId(value: string, name: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${ERROR_PREFIX} ${name} must be a non-empty, server-derived id.`);
  }
}
