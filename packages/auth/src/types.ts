/**
 * Domain types for the auth layer.
 *
 * These mirror the SLATE-200 / SLATE-202 migrations in
 * `packages/database/src/migrations` and are thin, source-typed records.
 *
 * Every identifier is server-derived (Master Plan Section 13): user ids, role
 * ids, permission ids, and tenant ids are never accepted from client input.
 */

export type UserId = string;
export type RoleId = string;
export type PermissionId = string;
export type TenantId = string;

/** Status of an application user account. */
export type UserStatus = 'active' | 'inactive' | 'locked';

/** Possible values for {@link UserStatus}. */
export const USER_STATUS_ACTIVE: UserStatus = 'active';
export const USER_STATUS_INACTIVE: UserStatus = 'inactive';
export const USER_STATUS_LOCKED: UserStatus = 'locked';

/**
 * Minimum fields every auth layer function needs from an `app_user` row.
 *
 * Extended by domain layers with extra columns (avatar, timezone, locale,
 * etc.) via module augmentation when they need more.
 */
export interface AuthUser {
  readonly id: UserId;
  readonly email: string;
  readonly name: string;
  readonly status: UserStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** A role that belongs to a tenant. */
export interface Role {
  readonly id: RoleId;
  readonly tenantId: TenantId;
  readonly name: string;
  readonly description: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** A tenant-scoped permission (e.g. "users.read"). */
export interface Permission {
  readonly id: PermissionId;
  readonly tenantId: TenantId;
  /** The stable permission key routes check against (e.g. "users.read"). */
  readonly key: string;
  readonly description: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Many-to-many link between a role and a permission. */
export interface RolePermission {
  readonly roleId: RoleId;
  readonly permissionId: PermissionId;
  readonly grantedAt: Date;
}

/** Membership of a user in a tenant, bound to a role. */
export interface TenantMembership {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly userId: UserId;
  readonly roleId: RoleId | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** The resolved set of permissions for a user in a tenant. */
export interface UserPermissionsInTenant {
  readonly tenantId: TenantId;
  readonly userId: UserId;
  readonly permissionKeys: readonly string[];
}

/** Parameters for the permission evaluator. */
export interface HasPermissionParams {
  readonly userId: UserId;
  readonly tenantId: TenantId;
  readonly permission: string;
}

export type { OwnershipPolicy } from './permissions/ownership.ts';

/**
 * Slim principal surface the auth package consumes from `@slate/tenant-context`.
 */
export interface AuthPrincipal {
  readonly userId: UserId;
  readonly activeTenantId: TenantId;
  readonly tenantIds: readonly TenantId[];
}

// ---------------------------------------------------------------------------
// Row parsers: bridge from Kysely row types to domain types.
// ---------------------------------------------------------------------------

/**
 * Parse an `app_user` Kysely row into a domain {@link AuthUser}.
 *
 * The query service selects `display_name` (aliased) and `is_active` (boolean);
 * the parser converts the boolean `is_active` into a {@link UserStatus} string.
 */
export function parseAuthUserRow(row: {
  readonly id: string;
  readonly email: string;
  readonly display_name: string;
  readonly is_active: boolean;
  readonly created_at: Date;
  readonly updated_at: Date;
}): AuthUser {
  return {
    id: row.id,
    email: row.email,
    name: row.display_name,
    status: row.is_active ? USER_STATUS_ACTIVE : USER_STATUS_INACTIVE,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Parse a `role` Kysely row into a domain {@link Role}. */
export function parseRoleRow(row: {
  readonly id: string;
  readonly tenant_id: string;
  readonly name: string;
  readonly description: string;
  readonly created_at: Date;
  readonly updated_at: Date;
}): Role {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Parse a `permission` Kysely row into a domain {@link Permission}. */
export function parsePermissionRow(row: {
  readonly id: string;
  readonly tenant_id: string;
  readonly key: string;
  readonly description: string;
  readonly created_at: Date;
  readonly updated_at: Date;
}): Permission {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    key: row.key,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Parse a `role_permission` Kysely row into a domain {@link RolePermission}. */
export function parseRolePermissionRow(row: {
  readonly role_id: string;
  readonly permission_id: string;
  readonly granted_at: Date;
}): RolePermission {
  return {
    roleId: row.role_id,
    permissionId: row.permission_id,
    grantedAt: row.granted_at,
  };
}

/** Parse a `tenant_membership` Kysely row into a domain {@link TenantMembership}. */
export function parseTenantMembershipRow(row: {
  readonly id: string;
  readonly tenant_id: string;
  readonly app_user_id: string;
  readonly role_id: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}): TenantMembership {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.app_user_id,
    roleId: row.role_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
