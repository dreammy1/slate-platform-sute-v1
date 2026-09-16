/**
 * Object-ownership lookups for the authorization spine (SLATE-202).
 *
 * Ownership grants *additional* permissions to the owner of a resource, on top
 * of role-based permissions. The contract is deliberately narrow:
 *
 * - `OwnershipCheck` names one resource: `resourceType` (e.g. `"document"`)
 *   plus `resourceId` (server-derived, never a raw client value).
 * - `OwnershipPolicy` answers whether a user owns that resource, and if so
 *   which extra permission *keys* ownership confers.
 * - `ownershipPermissionsFor` is the evaluator's seam: it returns `[]` when no
 *   policy is installed or the user owns nothing, so callers never branch.
 *
 * Policies are implemented by domain layers (each layer knows what "owns"
 * means for its resources); this module only defines the contract and the
 * input validation both sides share.
 */

import type { TenantId, UserId } from '../types.ts';

const ERROR_PREFIX = '[slate/auth]';

/**
 * One ownership question: does `userId` own `resourceType`/`resourceId`
 * inside `tenantId`?
 */
export interface OwnershipCheck {
  readonly userId: UserId;
  readonly tenantId: TenantId;
  readonly resourceType: string;
  readonly resourceId: string;
}

/**
 * Domain-implemented policy granting owner-level permissions.
 *
 * Returns the extra permission *keys* conferred by ownership, or `null` when
 * the user does not own the resource at all. A policy must scope its answer
 * to the tenant carried by the check - an owner in tenant A never gains keys
 * in tenant B through this surface.
 */
export interface OwnershipPolicy {
  getOwnerPermissions(check: OwnershipCheck): readonly string[] | null;
}

/**
 * Returns the ownership-granted permission keys for one check.
 *
 * `[]` when no policy is installed or the user owns nothing - never `null`.
 * Domain layers union this with the role-based set from
 * `getPermissionsForUser`.
 */
export function ownershipPermissionsFor(
  check: OwnershipCheck,
  policy?: OwnershipPolicy | undefined,
): readonly string[] {
  assertOwnershipCheck(check);
  if (policy === undefined) {
    return [];
  }
  const granted = policy.getOwnerPermissions(check);
  if (granted === null) {
    return [];
  }
  return [...granted].sort();
}

function assertOwnershipCheck(check: OwnershipCheck): void {
  assertServerId(check.userId, 'userId');
  assertServerId(check.tenantId, 'tenantId');
  if (typeof check.resourceType !== 'string' || check.resourceType.trim() === '') {
    throw new Error(`${ERROR_PREFIX} resourceType must be a non-empty string.`);
  }
  if (typeof check.resourceId !== 'string' || check.resourceId.trim() === '') {
    throw new Error(`${ERROR_PREFIX} resourceId must be a non-empty, server-derived id.`);
  }
}

function assertServerId(value: string, name: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${ERROR_PREFIX} ${name} must be a non-empty, server-derived id.`);
  }
}
