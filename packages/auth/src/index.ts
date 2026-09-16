/**
 * Authentication anchor and authorization spine for the Slate Next-Gen Platform
 * (SLATE-202).
 *
 * ## Authentication (authn)
 *
 * {@link getCurrentUser} resolves the {@link AuthUser} row for a server-derived
 * user ID. It returns `null` when the user does not exist or is inactive.
 *
 * ## Authorization (authz)
 *
 * {@link hasPermission} checks whether a user holds a permission key in a
 * tenant. {@link getPermissionsForUser} returns the full set.
 *
 * ## Security
 *
 * - User IDs are server-derived (Master Plan Section 13); the evaluator never
 *   trusts client-provided IDs.
 * - The evaluator **never caches** permission sets. Every call re-queries the
 *   database, so a role's permission revoked mid-session is immediately
 *   reflected (Master Plan Section 65).
 * - Permissions are tenant-scoped: cross-tenant leakage is structurally
 *   impossible.
 *
 * ## Out of scope
 *
 * External identity providers, OAuth, password hashing specifics, RBAC UI —
 * see docs/adr/002-authentication-and-authorization.md.
 */

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

/** @internal */
export type { AuthUser } from './types.ts';
export { AuthUserStatus } from './user.ts';
export type { UserId } from './types.ts';
/** @internal */
export { getCurrentUser } from './user.ts';
/** @internal */
export { type AuthQueryService, createAuthQueryService, AuthAuthenticationError } from './user.ts';

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

export type {
  Role,
  Permission,
  RolePermission,
  TenantMembership,
  UserPermissionsInTenant,
  HasPermissionParams,
  OwnershipPolicy,
  AuthPrincipal,
  RoleId,
  PermissionId,
  TenantId,
} from './types.ts';
export type { AuthorizationResult } from './permissions/evaluator.ts';
export type { PermissionEvaluator } from './permissions/evaluator.ts';
export {
  createPermissionEvaluator,
  PermissionAuthorizationError as EvaluatorPermissionAuthorizationError,
} from './permissions/evaluator.ts';
export { PermissionAuthorizationError } from './permissions/errors.ts';
export type { PermissionQueryService } from './permissions/query-service.ts';
export { createPermissionQueryService } from './permissions/query-service.ts';
export { hasPermission, getPermissionsForUser, findPermission } from './permissions/index.ts';

/**
 * The one wiring factory for the auth layer. It lives in
 * `./permissions/index.ts` next to the evaluator/query-service wiring it
 * composes; this re-export keeps the package's single public entry point
 * (`@slate/auth`) canonical — a second definition here would silently shadow
 * it (they are not the same type).
 */
export { createAuth } from './permissions/index.ts';
