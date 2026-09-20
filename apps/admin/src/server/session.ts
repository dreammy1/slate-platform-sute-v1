/**
 * Server-side session hydration for the admin screens (SLATE-301 helper,
 * consumed by SLATE-302).
 *
 * The cookie is read here, verified with the same codec the mounted API uses,
 * and resolved against fresh database reads — never a cached permission set
 * (ADR 002/009). Everything below the boundary is data: the layout passes a
 * {@link AdminActor} to the admin services and never a cookie or DB handle.
 */

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { createAuth } from '@slate/auth';
import {
  SESSION_COOKIE_NAME,
  hydrateShellSession,
  type ShellHydration,
  type ShellSession,
  type ShellSessionStores,
} from '@slate/api-client/server';

import type { AdminActor } from './admin/permissions.ts';
import { platformRuntime } from './platform.ts';

/** What the layout receives: a hydrated session, a tenardless state, or a reason. */
export type AdminSession = ShellHydration;

/** The actor the admin services authorize: identity plus fresh permissions. */
export function actorFromSession(session: ShellSession): AdminActor {
  return {
    userId: session.user.id,
    tenantId: session.activeTenantId,
    permissions: session.permissions,
  };
}

/**
 * Resolves the session for a protected admin render. A missing or unverifiable
 * cookie, an unknown user or a missing membership all reduce to the
 * `unauthenticated` state; the layout decides the redirect (ADR 009 §5).
 */
export async function requireSession(): Promise<AdminSession> {
  const runtime = await platformRuntime();
  if (runtime === undefined) {
    return { kind: 'unauthenticated', reason: 'no-session' };
  }

  const store = await cookies();
  const value = store.get(SESSION_COOKIE_NAME)?.value;
  const cookieHeader = value === undefined ? undefined : `${SESSION_COOKIE_NAME}=${value}`;

  const db = runtime.db;
  const auth = createAuth(db);
  const stores: ShellSessionStores = {
    async getUser(userId) {
      const row = await db
        .selectFrom('app_user')
        .select(['id', 'email', 'display_name'])
        .where('id', '=', userId)
        .executeTakeFirst();
      return row === undefined ? null : { id: row.id, email: row.email, name: row.display_name };
    },
    async listMemberships(userId) {
      return db
        .selectFrom('tenant_membership')
        .innerJoin('tenant', 'tenant.id', 'tenant_membership.tenant_id')
        .innerJoin('organization', 'organization.id', 'tenant.organization_id')
        .where('tenant_membership.app_user_id', '=', userId)
        .select([
          'tenant.id as tenantId',
          'tenant.name as tenantName',
          'organization.name as organizationName',
        ])
        .orderBy('tenant.name')
        .execute();
    },
    async getPermissions(userId, tenantId) {
      const permissions = await auth.getPermissionsForUser(userId, tenantId);
      return permissions.permissionKeys;
    },
  };

  return hydrateShellSession({ codec: runtime.codec, stores, cookieHeader });
}

/**
 * The actor a protected page or server action operates as. Anything short of a
 * fully hydrated session redirects to the signed-out root, so a module screen
 * cannot be reached without one (ADR 009 §5).
 */
export async function requireActor(): Promise<AdminActor> {
  const session = await requireSession();
  // `kind` marks the two states that are not a usable session (tenardless or
  // unauthenticated); a fully hydrated session has no discriminant.
  if ('kind' in session) redirect('/');
  return actorFromSession(session);
}
