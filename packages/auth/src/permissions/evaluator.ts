/**
 * The permission evaluator: the authorization spine every API route consults
 * (SLATE-202).
 *
 * Gate in flight: **Organization → User → Permission**. The evaluator is the
 * Permission step: given a server-derived user id and tenant id, it answers
 * whether the user holds a permission key in that tenant.
 *
 * Two invariants, both load-bearing:
 *
 * - **Tenant isolation.** The permission set comes from the query service,
 *   which pins `tenant_membership.tenant_id` *and* `permission.tenant_id` to
 *   the requested tenant. A tenant's users cannot see another tenant's
 *   permissions: the query can only return keys belonging to the named tenant.
 * - **No stale grants (Section 65).** The evaluator holds no cache of any
 *   kind. Every `hasPermission` / `getPermissionsForUser` call re-queries the
 *   database, so a role's permission revoked mid-session is gone immediately.
 */

import { PermissionAuthorizationError } from './errors.ts';
import { ownershipPermissionsFor, type OwnershipPolicy } from './ownership.ts';
import type { PermissionQueryService } from './query-service.ts';
import type { HasPermissionParams, TenantId, UserId, UserPermissionsInTenant } from '../types.ts';

export { PermissionAuthorizationError } from './errors.ts';

/**
 * The evaluator surface: what API routes consult.
 *
 * Constructed once per request (or once per process — it is stateless) via
 * {@link createPermissionEvaluator}. All inputs are server-derived ids
 * (Section 13); the evaluator never parses a client payload.
 */
export interface PermissionEvaluator {
  /**
   * The full permission set for a user in a tenant: role-based keys from the
   * query service unioned with owner-level keys when `ownership` matches.
   * Distinct and sorted. Re-queried on every call (Section 65).
   */
  getPermissionsForUser(
    userId: UserId,
    tenantId: TenantId,
    ownership?: OwnershipInput | undefined,
  ): Promise<UserPermissionsInTenant>;
  /**
   * Whether the user holds `permission` in the tenant. `false` — never a
   * throw — when the key is absent, unknown, or outside the tenant.
   */
  hasPermission(
    params: HasPermissionParams & { ownership?: OwnershipInput | undefined },
  ): Promise<boolean>;
  /**
   * Like {@link hasPermission}, but throws {@link PermissionAuthorizationError}
   * instead of returning `false`. For routes that want fail-closed control
   * flow without branching on a boolean.
   */
  assertPermission(
    params: HasPermissionParams & { ownership?: OwnershipInput | undefined },
  ): Promise<void>;
}

/**
 * Ownership input for one evaluator call: the resource under check plus the
 * domain-implemented policy that knows what "owns" means for it.
 */
export interface OwnershipInput {
  readonly resourceType: string;
  readonly resourceId: string;
  readonly policy: OwnershipPolicy;
}

/** Options accepted by {@link createPermissionEvaluator}. */
export interface CreatePermissionEvaluatorOptions {
  /** The database-backed (or faked, in unit tests) permission source. */
  readonly queryService: PermissionQueryService;
}

/** Authorization verdict with the evaluated permission set attached. */
export interface AuthorizationResult {
  readonly allowed: boolean;
  readonly userId: UserId;
  readonly tenantId: TenantId;
  readonly permission: string;
  readonly permissionKeys: readonly string[];
}

/**
 * Builds the stateless permission evaluator.
 *
 * The returned evaluator holds no per-user state — in particular no permission
 * cache — so mid-session revocations take effect on the very next call.
 */
export function createPermissionEvaluator(
  options: CreatePermissionEvaluatorOptions,
): PermissionEvaluator {
  const { queryService } = options;

  return { getPermissionsForUser, hasPermission, assertPermission };

  async function getPermissionsForUser(
    userId: UserId,
    tenantId: TenantId,
    ownership?: OwnershipInput | undefined,
  ): Promise<UserPermissionsInTenant> {
    assertServerId(userId, 'userId');
    assertServerId(tenantId, 'tenantId');

    // Fresh read on every call: the Section 65 invariant lives here.
    const roleKeys = await queryService.getPermissionsForUser(userId, tenantId);

    const ownerKeys =
      ownership === undefined
        ? []
        : ownershipPermissionsFor(
            {
              userId,
              tenantId,
              resourceType: ownership.resourceType,
              resourceId: ownership.resourceId,
            },
            ownership.policy,
          );

    const keys = [...new Set([...roleKeys, ...ownerKeys])].sort();
    return { tenantId, userId, permissionKeys: keys };
  }

  async function hasPermission(
    params: HasPermissionParams & { ownership?: OwnershipInput | undefined },
  ): Promise<boolean> {
    assertPermissionKey(params.permission);
    const set = await getPermissionsForUser(params.userId, params.tenantId, params.ownership);
    return set.permissionKeys.includes(params.permission);
  }

  async function assertPermission(
    params: HasPermissionParams & { ownership?: OwnershipInput | undefined },
  ): Promise<void> {
    const allowed = await hasPermission(params);
    if (!allowed) {
      throw PermissionAuthorizationError.create(params.userId, params.tenantId, params.permission);
    }
  }
}

function assertServerId(value: string, name: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`[slate/auth] ${name} must be a non-empty, server-derived id.`);
  }
}

function assertPermissionKey(value: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('[slate/auth] permission must be a non-empty string.');
  }
}
