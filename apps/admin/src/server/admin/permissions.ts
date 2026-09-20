/**
 * Admin permission keys and the privilege-escalation guard (SLATE-302, ADR 010).
 *
 * The guard is the property that keeps an administrator from handing out
 * authority it does not itself hold: a role assignment is allowed only when every
 * permission the role carries is present in the actor's own, freshly read set.
 * It is pure — both sets are server-resolved, never client input — so the exact
 * rule is unit-tested and shared by the service and its tests (Section 65).
 */

/** Permission keys the admin modules gate on (ADR 010 §1). */
export const ADMIN_PERMISSIONS = {
  tenantRead: 'tenants.read',
  tenantManage: 'tenants.manage',
  userRead: 'users.read',
  userManage: 'users.manage',
  roleManage: 'roles.manage',
  flagRead: 'settings.read',
  flagManage: 'settings.manage',
  healthRead: 'health.read',
} as const;

/** Union of the admin permission keys. */
export type AdminPermission = (typeof ADMIN_PERMISSIONS)[keyof typeof ADMIN_PERMISSIONS];

/** The server-resolved actor: identity plus its fresh permissions in one tenant. */
export interface AdminActor {
  readonly userId: string;
  readonly tenantId: string;
  readonly permissions: readonly string[];
}

/** Raised when the actor lacks the permission a module action requires. */
export class AdminAuthorizationError extends Error {
  /** HTTP status the caller maps this to (the platform's denial shape). */
  readonly status = 403;

  constructor(permission: string) {
    super(`The acting user does not hold "${permission}" (ADR 010 §1).`);
    this.name = 'AdminAuthorizationError';
  }
}

/**
 * Raised when a grant would exceed the actor's own privileges. Both a role
 * assignment and a role edit route through this check, so neither can widen the
 * actor (ADR 010 §3).
 */
export class AdminEscalationError extends Error {
  readonly status = 403;
  /** The permissions that made the grant an escalation, sorted and unique. */
  readonly escalated: readonly string[];

  constructor(escalated: readonly string[]) {
    const sorted = [...new Set(escalated)].sort();
    super(
      `Refusing to grant ${sorted.join(', ')}: the acting user does not hold these ` +
        'permissions, so the grant would escalate privilege (ADR 010 §3).',
    );
    this.name = 'AdminEscalationError';
    this.escalated = sorted;
  }
}

/** Asserts the actor holds `permission`; throws {@link AdminAuthorizationError}. */
export function requirePermission(actor: AdminActor, permission: string): void {
  if (!actor.permissions.includes(permission)) throw new AdminAuthorizationError(permission);
}

/**
 * The permissions in `granted` that `held` does not contain — the escalation set.
 * Deterministic (sorted, de-duplicated) so callers and tests agree on ordering.
 */
export function findEscalatedPermissions(
  granted: readonly string[],
  held: readonly string[],
): readonly string[] {
  const heldSet = new Set(held);
  return [...new Set(granted.filter((key) => !heldSet.has(key)))].sort();
}

/** `true` when every granted permission is within the actor's own set. */
export function isGrantWithinAuthority(
  granted: readonly string[],
  held: readonly string[],
): boolean {
  return findEscalatedPermissions(granted, held).length === 0;
}

/** Asserts a grant stays within the actor's authority; throws {@link AdminEscalationError}. */
export function assertNoEscalation(granted: readonly string[], held: readonly string[]): void {
  const escalated = findEscalatedPermissions(granted, held);
  if (escalated.length > 0) throw new AdminEscalationError(escalated);
}
