/**
 * Route-level conveniences and the `createAuth` wiring factory.
 *
 * These complement the evaluator methods in `./evaluator.ts` (kept separate so
 * that file stays focused on the evaluation semantics): thin helpers for
 * routes plus the one factory that binds the auth layer to a real database
 * client.
 */

import {
  createPermissionEvaluator,
  type OwnershipInput,
  type PermissionEvaluator,
} from './evaluator.ts';
import { PermissionAuthorizationError } from './errors.ts';
import { createPermissionQueryService } from './query-service.ts';
import { createAuthQueryService, type AuthQueryService } from '../user.ts';
import type { HasPermissionParams, TenantId, UserId, UserPermissionsInTenant } from '../types.ts';

export type { AuthorizationResult } from './evaluator.ts';
export { PermissionAuthorizationError };

/**
 * Route-level convenience: `true` when the user holds the permission key in
 * the tenant (ownership-aware when `ownership` is provided).
 */
export async function hasPermission(
  evaluator: PermissionEvaluator,
  params: HasPermissionParams & { ownership?: OwnershipInput | undefined },
): Promise<boolean> {
  return evaluator.hasPermission(params);
}

/**
 * Route-level convenience: the full permission set for a user in a tenant.
 */
export async function getPermissionsForUser(
  evaluator: PermissionEvaluator,
  userId: UserId,
  tenantId: TenantId,
  ownership?: OwnershipInput | undefined,
): Promise<UserPermissionsInTenant> {
  return evaluator.getPermissionsForUser(userId, tenantId, ownership);
}

/** Resolves one tenant-scoped permission key to its row id, or `null`. */
export async function findPermission(
  queryService: { findPermission(tenantId: TenantId, key: string): Promise<{ id: string } | null> },
  tenantId: TenantId,
  key: string,
): Promise<{ id: string } | null> {
  return queryService.findPermission(tenantId, key);
}

/** The wired auth surface returned by {@link createAuth}. */
export interface Auth {
  readonly evaluator: PermissionEvaluator;
  readonly users: AuthQueryService;
  readonly getCurrentUser: AuthQueryService['getCurrentUser'];
  readonly hasPermission: PermissionEvaluator['hasPermission'];
  readonly getPermissionsForUser: PermissionEvaluator['getPermissionsForUser'];
}

/**
 * Wires the full auth layer against one database client.
 *
 * @param db - a Kysely<Database> client (tenant-scoped in production via
 *   `@slate/tenant-context`'s `tenantDatabaseFor`; a plain client in tests).
 */
export function createAuth(db: import('kysely').Kysely<import('@slate/database').Database>): Auth {
  const users = createAuthQueryService(db);
  const permissions = createPermissionQueryService(db);
  const evaluator = createPermissionEvaluator({ queryService: permissions });
  return {
    evaluator,
    users,
    getCurrentUser: (userId: UserId) => users.getCurrentUser(userId),
    hasPermission: (params) => evaluator.hasPermission(params),
    getPermissionsForUser: (userId, tenantId, ownership) =>
      evaluator.getPermissionsForUser(userId, tenantId, ownership),
  };
}
