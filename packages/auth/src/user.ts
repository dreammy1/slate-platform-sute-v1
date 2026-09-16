/**
 * Authentication anchor for the Slate Next-Gen Platform (SLATE-202).
 *
 * {@link getCurrentUser} fetches the {@link AuthUser} row for a server-derived
 * user ID. Returns `null` when the user does not exist or is inactive.
 *
 * User IDs are server-derived (Master Plan Section 13): the caller must pass a
 * userId obtained from the authenticated principal (`AuthenticatedPrincipal`),
 * never from a client payload. This module never trusts a client-provided ID.
 */

import type { Kysely } from 'kysely';
import type { Database } from '@slate/database';

import { parseAuthUserRow } from './types.ts';
import type { AuthUser, UserId } from './types.ts';

/** Thrown when authentication fails because the principal is missing. */
export class AuthAuthenticationError extends Error {
  override readonly name = 'AuthAuthenticationError';
  readonly code: 'AUTH_NOT_FOUND' | 'AUTH_UNAUTHORIZED' | 'AUTH_REVOKED';

  private constructor(
    message: string,
    code: 'AUTH_NOT_FOUND' | 'AUTH_UNAUTHORIZED' | 'AUTH_REVOKED',
  ) {
    super(message);
    this.code = code;
    Object.setPrototypeOf(this, AuthAuthenticationError.prototype);
  }

  /** The user does not exist in the database. */
  static notFound(userId: UserId): AuthAuthenticationError {
    return new AuthAuthenticationError(
      `authenticated principal references unknown user ${userId}`,
      'AUTH_NOT_FOUND',
    );
  }

  /** The session principal itself is absent (no userId). */
  static unauthorized(): AuthAuthenticationError {
    return new AuthAuthenticationError(
      'authenticated principal is missing a user identifier',
      'AUTH_UNAUTHORIZED',
    );
  }

  /** The user account is revoked / locked. */
  static revoked(userId: UserId): AuthAuthenticationError {
    return new AuthAuthenticationError(
      `user ${userId} account status prohibits authentication`,
      'AUTH_REVOKED',
    );
  }
}

// ---------------------------------------------------------------------------
// Query service (abstracts the database so unit tests can fake it)
// ---------------------------------------------------------------------------

/**
 * Abstractions over the `app_user` table, injectable for unit testing.
 *
 * Implementations talk to the real database; fakes model the contract for
 * hermetic unit tests. The evaluator (SLATE-202 §65) depends on this surface
 * so it can be tested without a real Postgres connection.
 */
export interface AuthQueryService {
  /** Fetch the user row by server-derived ID, or `null` when not present. */
  getCurrentUser(userId: UserId): Promise<AuthUser | null>;
  /** Distinct, sorted permission keys for a user in a tenant. */
  getPermissionsForUser(userId: UserId, tenantId: string): Promise<readonly string[]>;
  /** Resolve one tenant-scoped permission key to its row id, or `null`. */
  findPermission(tenantId: string, key: string): Promise<{ id: string } | null>;
}

/**
 * Builds an `AuthQueryService` backed by a real Kysely<Database>.
 *
 * @param db - a tenant-scoped database instance (e.g. from
 *   `@slate/tenant-context`'s `tenantDatabaseFor` or `@slate/database`'s
 *   `createTenantDatabase`).
 */
export function createAuthQueryService(db: Kysely<Database>): AuthQueryService {
  return {
    getCurrentUser,
    getPermissionsForUser,
    findPermission,
  };

  async function getCurrentUser(userId: UserId): Promise<AuthUser | null> {
    if (typeof userId !== 'string' || userId.trim() === '') {
      throw AuthAuthenticationError.unauthorized();
    }
    // Section 13: userId is server-derived; never parsed from a client payload
    // here. We trust the caller (which is the session principal) and let the
    // database lookup enforce existence / status.
    const row = await db
      .selectFrom('app_user')
      .where('app_user.id', '=', userId)
      .select([
        'app_user.id as id',
        'app_user.email as email',
        'app_user.display_name as display_name',
        'app_user.is_active as is_active',
        'app_user.created_at as created_at',
        'app_user.updated_at as updated_at',
      ])
      .limit(1)
      .executeTakeFirst();

    if (row === undefined) {
      return null;
    }

    const user = parseAuthUserRow(row);
    return authUserStatusAllowsAuth(user.status) ? user : null;
  }

  async function getPermissionsForUser(
    userId: UserId,
    tenantId: string,
  ): Promise<readonly string[]> {
    if (typeof userId !== 'string' || userId.trim() === '') {
      throw AuthAuthenticationError.unauthorized();
    }
    if (typeof tenantId !== 'string' || tenantId.trim() === '') {
      throw new Error('[slate/auth] tenantId must be a non-empty, server-derived id.');
    }
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

  async function findPermission(tenantId: string, key: string): Promise<{ id: string } | null> {
    if (typeof tenantId !== 'string' || tenantId.trim() === '') {
      throw new Error('[slate/auth] tenantId must be a non-empty, server-derived id.');
    }
    if (typeof key !== 'string' || key.trim() === '') {
      throw new Error('[slate/auth] permission key must be a non-empty string.');
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

/** Possible statuses of an application user account. */
export const AuthUserStatus = {
  ACTIVE: 'active',
  INACTIVE: 'inactive',
  LOCKED: 'locked',
} as const;
export type AuthUserStatus = (typeof AuthUserStatus)[keyof typeof AuthUserStatus];

/**
 * Returns true when the user status permits authentication.
 *
 * @internal used by {@link getCurrentUser} to decide whether to return `null`.
 */
export function authUserStatusAllowsAuth(status: string): boolean {
  return status === AuthUserStatus.ACTIVE;
}

/**
 * Standalone `getCurrentUser` for the SLATE-202 API contract
 * (`getCurrentUser(db, userId)`): resolves the {@link AuthUser} for a
 * server-derived user id, or `null` when the user does not exist or is
 * inactive.
 */
export async function getCurrentUser(
  db: Kysely<Database>,
  userId: UserId,
): Promise<AuthUser | null> {
  return createAuthQueryService(db).getCurrentUser(userId);
}
