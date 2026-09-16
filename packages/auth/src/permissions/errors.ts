/**
 * Authorization errors for the auth layer (SLATE-202).
 *
 * These errors are thrown when authorization checks fail. They deliberately
 * avoid leaking the full permission space in public-facing messages (SLATE-202
 * security requirement: §65 adversarial cases).
 */

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown when the queried permission does not exist in the tenant. */
export class PermissionNotFoundError extends Error {
  override readonly name = 'PermissionNotFoundError';
  readonly permission: string;
  readonly tenantId: string;

  private constructor(permission: string, tenantId: string) {
    super(`permission "${permission}" does not exist in tenant ${tenantId}`);
    this.permission = permission;
    this.tenantId = tenantId;
    Object.setPrototypeOf(this, PermissionNotFoundError.prototype);
  }

  static create(permission: string, tenantId: string): PermissionNotFoundError {
    return new PermissionNotFoundError(permission, tenantId);
  }
}

/**
 * Thrown by {@link hasPermission} when the user does not hold the requested
 * permission in the tenant.
 *
 * The message deliberately omits the permission key on the public surface so
 * that authorization failures returned to callers do not enumerate the
 * permission space. Internal logs (via the query service's logger) may include
 * the key.
 */
export class PermissionAuthorizationError extends Error {
  override readonly name = 'PermissionAuthorizationError';
  readonly userId: string;
  readonly tenantId: string;
  /** The denied permission key, exported for internal assertions/tests only. */
  readonly deniedPermission: string;

  private constructor(userId: string, tenantId: string, deniedPermission: string) {
    super(`user ${userId} is not authorized for tenant ${tenantId}`);
    this.userId = userId;
    this.tenantId = tenantId;
    this.deniedPermission = deniedPermission;
    Object.setPrototypeOf(this, PermissionAuthorizationError.prototype);
  }

  static create(
    userId: string,
    tenantId: string,
    deniedPermission: string,
  ): PermissionAuthorizationError {
    return new PermissionAuthorizationError(userId, tenantId, deniedPermission);
  }
}
