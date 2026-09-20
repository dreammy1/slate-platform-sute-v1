/**
 * User and role administration (SLATE-302, ADR 010 §3).
 *
 * The escalation guard is the load-bearing rule: an actor may only assign a role
 * whose permissions it holds itself, read fresh at the moment of the write. The
 * server enforces it; the UI merely hides controls it cannot use. Every write is
 * audited in the same transaction.
 */

import type { Kysely } from 'kysely';

import { createTenantDatabase, type Database } from '@slate/database';

import { recordAudit } from './audit.ts';
import {
  ADMIN_PERMISSIONS,
  assertNoEscalation,
  requirePermission,
  type AdminActor,
} from './permissions.ts';

/** A tenant member with its role, as the user list shows it. */
export interface AdminUser {
  readonly userId: string;
  readonly email: string;
  readonly name: string;
  readonly isActive: boolean;
  readonly roleId: string | null;
  readonly roleName: string | null;
}

/** A role and the permission keys it carries. */
export interface AdminRole {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly permissionKeys: readonly string[];
}

/** Raised when a referenced user or role is not in the actor's tenant. */
export class AdminNotFoundError extends Error {
  readonly status = 404;

  constructor(what: string) {
    super(`The ${what} was not found in the acting tenant (ADR 010 §3).`);
    this.name = 'AdminNotFoundError';
  }
}

/** The user/role admin surface. */
export interface UserAdminService {
  listUsers(actor: AdminActor): Promise<readonly AdminUser[]>;
  listRoles(actor: AdminActor): Promise<readonly AdminRole[]>;
  assignRole(
    actor: AdminActor,
    input: { readonly userId: unknown; readonly roleId: unknown },
  ): Promise<void>;
}

/** Wires the user/role admin service to a database client. */
export function createUserAdminService(db: Kysely<Database>): UserAdminService {
  async function rolePermissionKeys(tenantId: string, roleId: string): Promise<readonly string[]> {
    const rows = await createTenantDatabase(db, tenantId)
      .selectFrom('permission')
      .innerJoin('role_permission', 'role_permission.permission_id', 'permission.id')
      .where('role_permission.role_id', '=', roleId)
      .select('permission.key as key')
      .execute();
    return rows.map((row) => row.key);
  }

  return {
    async listUsers(actor) {
      requirePermission(actor, ADMIN_PERMISSIONS.userRead);
      const rows = await createTenantDatabase(db, actor.tenantId)
        .selectFrom('tenant_membership')
        .innerJoin('app_user', 'app_user.id', 'tenant_membership.app_user_id')
        .select([
          'app_user.id as userId',
          'app_user.email as email',
          'app_user.display_name as name',
          'app_user.is_active as isActive',
          'tenant_membership.role_id as roleId',
        ])
        .orderBy('app_user.email')
        .execute();
      const roles = await createTenantDatabase(db, actor.tenantId)
        .selectFrom('role')
        .select(['id', 'name'])
        .execute();
      const roleNames = new Map(roles.map((role) => [role.id, role.name]));
      return rows.map((row) => ({
        userId: row.userId,
        email: row.email,
        name: row.name,
        isActive: row.isActive,
        roleId: row.roleId,
        roleName: row.roleId === null ? null : (roleNames.get(row.roleId) ?? null),
      }));
    },

    async listRoles(actor) {
      requirePermission(actor, ADMIN_PERMISSIONS.userRead);
      const roles = await createTenantDatabase(db, actor.tenantId)
        .selectFrom('role')
        .select(['id', 'name', 'description'])
        .orderBy('name')
        .execute();
      return Promise.all(
        roles.map(async (role) => ({
          ...role,
          permissionKeys: await rolePermissionKeys(actor.tenantId, role.id),
        })),
      );
    },

    async assignRole(actor, input) {
      requirePermission(actor, ADMIN_PERMISSIONS.roleManage);
      const userId = typeof input.userId === 'string' ? input.userId : '';
      const roleId = typeof input.roleId === 'string' ? input.roleId : '';
      if (userId === '' || roleId === '') throw new AdminNotFoundError('user or role');

      // The role must belong to the acting tenant; a foreign one is a 404.
      const role = await createTenantDatabase(db, actor.tenantId)
        .selectFrom('role')
        .select(['id', 'name'])
        .where('id', '=', roleId)
        .executeTakeFirst();
      if (role === undefined) throw new AdminNotFoundError('role');

      // Escalation guard: the role's fresh permission set must be within the
      // actor's own. A role that outranks the approver is refused (403).
      const granted = await rolePermissionKeys(actor.tenantId, role.id);
      assertNoEscalation(granted, actor.permissions);

      await db.transaction().execute(async (trx) => {
        await createTenantDatabase(trx, actor.tenantId)
          .insertInto('tenant_membership', { app_user_id: userId, role_id: role.id })
          .onConflict((conflict) =>
            conflict.columns(['tenant_id', 'app_user_id']).doUpdateSet({ role_id: role.id }),
          )
          .execute();
        await recordAudit(trx, {
          tenantId: actor.tenantId,
          actorUserId: actor.userId,
          action: 'admin.user.role-assigned',
          resourceType: 'tenant_membership',
          resourceId: userId,
          payload: { roleId: role.id, roleName: role.name, grantedPermissions: granted.length },
        });
      });
    },
  };
}
